/**
 * 系统语音播放和可取消的播放链。未完成真实播放的后端不能报告成功。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CLOUD_ENDPOINT } from '@awm/schema';

/** 单次播报入参 */
export interface SpeakOptions {
  text: string;
  voiceProfile?: string;
  rate?: number;
  /** 应用播放增益，系统输出设备和静音状态仍由操作系统控制。 */
  volume?: number;
}

/** 后端必须在播放完成或子进程退出后才结束 Promise。 */
export interface TtsBackend {
  readonly name: string;
  readonly unavailableReason?: string;
  isAvailable(): boolean;
  speak(options: SpeakOptions, signal?: AbortSignal): Promise<void>;
}

/** 可直接传给系统语音程序的本机音色。 */
export interface NativeVoice {
  id: string;
  name: string;
  language: string;
}

export interface NativeVoiceList {
  voices: NativeVoice[];
  error?: string;
}

/** 本机 AI 语音模型状态；瞬态数据，通过控制 API 与 SSE 传输，不进 settings。 */
export interface ModelStatus {
  state: 'missing' | 'downloading' | 'extracting' | 'ready' | 'error';
  /** 模型种类；旧版负载缺省视为 Kokoro。 */
  kind?: 'kokoro' | 'zipvoice';
  /** 下载进度百分比 0-100。 */
  percent?: number;
  /** 已接收字节数。 */
  bytes?: number;
  /** 总字节数（Content-Length，未知时为 0）。 */
  totalBytes?: number;
  /** state 为 error 时的有限长度原因说明。 */
  error?: string;
}

/** macOS 中文音色白名单条目；按数组顺序作为自动模式优先级。 */
export interface NativeVoiceRule {
  /** 匹配 `say -v ?` 输出的音色名（含括号后缀的完整名之前缀）。 */
  pattern: RegExp;
  /** 匹配语言标签。 */
  language: RegExp;
}

/**
 * 允许的音色：先普通话增强款，再普通话经典款，最后才轮到粤语/台湾经典款；
 * 列表末尾追加常用英文音色。增强款只放行 zh_CN：同名音色的台湾语区变体字音与
 * 大陆普通话不同（实测会加重多音字读错），不放进列表。
 * 自动优先级按数组顺序：播报文案默认是普通话，不能把粤语善怡排在最前。
 * 英文音色只可手动选择，永不参与自动优先级；Grandma/Grandpa 等未列入音色保持回落。
 */
export const NATIVE_VOICE_ALLOWLIST: readonly NativeVoiceRule[] = [
  { pattern: /^(?:Shelley)(?:\s*\(|$)/i, language: /^zh[_-]CN$/i },
  { pattern: /^(?:Sandy)(?:\s*\(|$)/i, language: /^zh[_-]CN$/i },
  { pattern: /^(?:Reed)(?:\s*\(|$)/i, language: /^zh[_-]CN$/i },
  { pattern: /^(?:Rocko)(?:\s*\(|$)/i, language: /^zh[_-]CN$/i },
  { pattern: /^(?:Eddy)(?:\s*\(|$)/i, language: /^zh[_-]CN$/i },
  { pattern: /^(?:Flo)(?:\s*\(|$)/i, language: /^zh[_-]CN$/i },
  { pattern: /^(?:Tingting|婷婷)(?:\s*\(|$)/i, language: /^zh[_-]CN$/i },
  { pattern: /^(?:Meijia|美佳)(?:\s*\(|$)/i, language: /^zh[_-]TW$/i },
  { pattern: /^(?:Sinji|善怡)(?:\s*\(|$)/i, language: /^zh[_-]HK$/i },
  {
    pattern:
      /^(?:Samantha|Alex|Daniel|Karen|Moira|Tessa|Rishi|Aman|Serena|Tom|Victoria|Klaus|Steffi|Oliver)(?:\s*\(|$)/i,
    language: /^en[_-]/i,
  },
];

/** @description: 自动播报只允许中文音色兜底；英文音色必须用户显式选择。 */
export function isChineseVoice(voice: NativeVoice): boolean {
  return /^zh[_-]/i.test(voice.language);
}

/** @description: 返回命中的白名单规则序号（自动优先级），未命中返回 -1。 */
function allowRank(voice: NativeVoice): number {
  return NATIVE_VOICE_ALLOWLIST.findIndex(
    (rule) => rule.pattern.test(voice.name) && rule.language.test(voice.language),
  );
}

/** @description: 保留命中白名单的音色并按规则顺序排序、按 id 去重。 */
export function filterNativeVoices(voices: NativeVoice[]): NativeVoice[] {
  const hits: { voice: NativeVoice; rank: number }[] = [];
  for (const voice of voices) {
    const rank = allowRank(voice);
    if (rank >= 0) hits.push({ voice, rank });
  }
  // 同名音色在不同语区各一条（如 Eddy 的 zh_CN / zh_TW），再按语言排一次保证顺序稳定。
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.voice.name.localeCompare(b.voice.name) ||
      a.voice.language.localeCompare(b.voice.language),
  );
  const seen = new Set<string>();
  const result: NativeVoice[] = [];
  for (const { voice } of hits) {
    const key = voice.name + '\0' + voice.language;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(voice);
  }
  return result;
}

/** @description: 保存的音色命中白名单则直通；空值、system-default 或未命中均返回 undefined（自动）。 */
export function resolveNativeVoice(
  profile: string | undefined,
  voices: readonly NativeVoice[],
): string | undefined {
  if (!profile || profile === 'system-default') return undefined;
  return voices.some((voice) => voice.id === profile) ? profile : undefined;
}

const PLAYBACK_TIMEOUT_MS = 30_000;
const VOICE_LIST_TIMEOUT_MS = 3_000;
const STDERR_LIMIT = 2048;
let installedChinese: Promise<NativeVoice[]> | undefined;

/** @description: 只列出白名单内已安装音色（中文优先、英文靠后）；不播放、不下载任何资源。 */
export function listNativeVoices(): Promise<NativeVoiceList> {
  if (process.platform !== 'darwin')
    return Promise.resolve({
      voices: [],
      error: '当前平台尚不支持列出原生音色，仍可使用系统默认语音',
    });
  if (!executable('/usr/bin/say'))
    return Promise.resolve({ voices: [], error: '未找到 macOS 系统语音程序 /usr/bin/say' });
  return new Promise((resolve) => {
    const failed = (
      error: Error & { killed?: boolean; code?: string | number | null },
      stderr = '',
    ): void => {
      const timeout =
        error.code === 'ETIMEDOUT' ||
        (error.killed && (error.code === null || error.code === undefined));
      const detail = (stderr.trim() || error.message).slice(-STDERR_LIMIT);
      resolve({
        voices: [],
        error: timeout
          ? '读取系统音色超时（3 秒）'
          : '无法读取系统音色' + (detail ? '：' + detail : ''),
      });
    };
    try {
      execFile(
        '/usr/bin/say',
        ['-v', '?'],
        { encoding: 'utf8', timeout: VOICE_LIST_TIMEOUT_MS, maxBuffer: 256 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            failed(error, stderr);
            return;
          }
          const found: NativeVoice[] = [];
          for (const line of stdout.split(/\r?\n/)) {
            const match = /^(.+?)\s+([a-z]{2,3}(?:[_-][a-z0-9]{2,8})+)\s+#/i.exec(line);
            if (!match) continue;
            found.push({ id: match[1].trim(), name: match[1].trim(), language: match[2] });
          }
          const voices = filterNativeVoices(found);
          resolve(
            voices.length > 0
              ? { voices }
              : {
                  voices,
                  error: '本机未安装可用的系统中文音色，暂不能播放中文播报；可在系统语音设置下载增强语音，或改用本地 AI 语音',
                },
          );
        },
      );
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * @description: 缓存白名单内已安装音色（按自动优先级排序），供列表与自动选择共用；失败清缓存可重试。
 */
function installedChineseVoices(): Promise<NativeVoice[]> {
  if (!installedChinese) {
    installedChinese = listNativeVoices()
      .then(({ voices, error }) => {
        if (error) throw new Error(error);
        if (!voices.length) throw new Error('本机未安装可用的系统中文音色');
        return voices;
      })
      .catch((error: unknown) => {
        installedChinese = undefined;
        throw error;
      });
  }
  return installedChinese;
}

/** @description: 检查系统生成的 16 位 AIFF 是否含非零 PCM 数据，而非仅有容器头或静音。 */
export function hasAiffSpeech(data: Buffer): boolean {
  if (
    data.length < 12 ||
    data.toString('ascii', 0, 4) !== 'FORM' ||
    !['AIFF', 'AIFC'].includes(data.toString('ascii', 8, 12))
  )
    return false;
  let pcm16 = false;
  for (let position = 12; position + 8 <= data.length;) {
    const kind = data.toString('ascii', position, position + 4);
    const size = data.readUInt32BE(position + 4);
    const body = position + 8;
    if (body + size > data.length) return false;
    if (kind === 'COMM' && size >= 18)
      pcm16 = data.readUInt16BE(body + 6) === 16 && data.readUInt32BE(body + 2) > 0;
    if (kind === 'SSND' && size > 8 && pcm16) {
      const start = body + 8 + data.readUInt32BE(body);
      return start < body + size && data.subarray(start, body + size).some((value) => value !== 0);
    }
    position = body + size + (size % 2);
  }
  return false;
}

/** @description: 直接检查可执行文件，不启动 shell，也不阻塞等待 which。 */
function executable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** @description: 仅在已有 PATH 中解析程序，不扩展到用户配置目录。 */
function findBinary(name: string): string | undefined {
  const suffixes =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const file = path.join(dir, name + suffix.toLowerCase());
      if (executable(file)) return file;
    }
  }
  return undefined;
}

/** @description: 获取本平台实际存在的系统语音程序。 */
function nativeBinary(): string | undefined {
  if (process.platform === 'darwin')
    return executable('/usr/bin/say') && executable('/usr/bin/afplay') ? '/usr/bin/say' : undefined;
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot;
    const file = system ? path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe') : '';
    return file && executable(file) ? file : findBinary('powershell');
  }
  return findBinary('espeak-ng') ?? findBinary('espeak');
}

/** @description: 等待真正退出；取消先终止进程，避免上一段音频与新音频重叠。 */
function waitChild(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let failure: Error | undefined;
    let stderr = '';
    let killTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (exitTimer) clearTimeout(exitTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error: Error): void => {
      if (settled || failure) return;
      failure = error;
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      exitTimer = setTimeout(() => finish(error), 1500);
      child.kill();
    };
    const onAbort = (): void => terminate(new Error('播报已打断'));
    const timer = setTimeout(() => terminate(new Error('系统语音播放超时')), PLAYBACK_TIMEOUT_MS);
    child.stderr?.on('data', (data: Buffer | string) => {
      stderr = (stderr + data.toString()).slice(-STDERR_LIMIT);
    });
    // 提前退出可能让写入 stdin 返回 EPIPE；由 close 的退出码统一解释。
    child.stdin?.on('error', () => undefined);
    child.once('error', (error: Error) => finish(new Error('TTS 启动失败：' + error.message)));
    child.once('close', (code: number | null) => {
      if (failure) finish(failure);
      else if (code === 0) finish();
      else
        finish(
          new Error('TTS 退出码 ' + String(code) + (stderr.trim() ? '：' + stderr.trim() : '')),
        );
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** @description: 只把文本交给 stdin，避免参数解析和命令行中暴露任务文本。 */
function playNative(binary: string, options: SpeakOptions, signal?: AbortSignal): Promise<void> {
  if (process.platform === 'darwin') return playMac(binary, options, signal);
  const rate = Math.min(2, Math.max(0.5, options.rate ?? 1));
  const args: string[] = [];
  if (process.platform === 'win32') {
    const profile =
      options.voiceProfile && options.voiceProfile !== 'system-default'
        ? "$s.SelectVoice('" + options.voiceProfile.replace(/'/g, "''") + "')"
        : '';
    const volume = Math.round(Math.min(1, Math.max(0, options.volume ?? 0.8)) * 100);
    const script = [
      '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding',
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$s.Rate = ' + String(Math.round((rate - 1) * 5)),
      '$s.Volume = ' + String(volume),
      profile,
      '$s.Speak([Console]::In.ReadToEnd())',
      '$s.Dispose()',
    ]
      .filter(Boolean)
      .join('; ');
    args.push('-NoProfile', '-NonInteractive', '-Command', script);
  } else {
    args.push('--stdin', '-s', String(Math.round(rate * 175)));
    if (options.voiceProfile && options.voiceProfile !== 'system-default')
      args.push('-v', options.voiceProfile);
    args.push('-a', String(Math.round(Math.min(1, Math.max(0, options.volume ?? 0.8)) * 200)));
  }
  const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const done = waitChild(child, signal);
  child.stdin?.end(options.text);
  return done;
}

/** @description: 先验证真实合成数据，再播放；临时音频在成功、失败和取消后均清理。 */
async function playMac(binary: string, options: SpeakOptions, signal?: AbortSignal): Promise<void> {
  // 共用缓存枚举：保存音色命中白名单直通；兜底只取首位中文音色，
  // 英文音色排在列表末尾、必须显式选择，避免中文播报落进英文音色。
  const voices = await installedChineseVoices();
  const voice =
    resolveNativeVoice(options.voiceProfile, voices) ?? voices.find(isChineseVoice)?.id;
  if (!voice) throw new Error('本机未安装可用的系统中文音色');
  if (signal?.aborted) throw new Error('播报已打断');
  const directory = await mkdtemp(path.join(tmpdir(), 'awm-speech-'));
  try {
    const file = path.join(directory, 'speech.aiff');
    const args = [
      '-r',
      String(Math.round(Math.min(2, Math.max(0.5, options.rate ?? 1)) * 180)),
      '-o',
      file,
      '-v',
      voice,
    ];
    const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    const synthesis = waitChild(child, signal);
    child.stdin?.end(options.text);
    await synthesis;
    if (!hasAiffSpeech(await readFile(file)))
      throw new Error('系统语音未生成有效音频，请检查音色与系统语音权限');
    if (signal?.aborted) throw new Error('播报已打断');
    const gain = String(Math.min(1, Math.max(0, options.volume ?? 0.8)));
    await waitChild(
      spawn('/usr/bin/afplay', ['-v', gain, file], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      }),
      signal,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** @description: 创建当前平台系统原生播放后端。 */
export function createNativeBackend(): TtsBackend {
  return {
    name: 'native',
    unavailableReason: '当前平台未找到可用的系统语音程序',
    isAvailable: () => nativeBinary() !== undefined,
    speak(options, signal) {
      const binary = nativeBinary();
      if (!binary) return Promise.reject(new Error('当前平台没有可用的原生 TTS'));
      if (signal?.aborted) return Promise.reject(new Error('播报已打断'));
      return playNative(binary, options, signal);
    },
  };
}

/**
 * @description: 播放本地已生成的音频文件（wav/aiff）；真实播放完成后删除该文件，
 * 取消与失败同样清理。空目录由调用方删除。仅接受本机生成的文件路径，不接收外部指令。
 */
export async function playAudioFile(
  file: string,
  volume: number,
  signal?: AbortSignal,
): Promise<void> {
  const gain = Math.min(1, Math.max(0, volume));
  try {
    if (signal?.aborted) throw new Error('播报已打断');
    if (process.platform === 'darwin') {
      if (!executable('/usr/bin/afplay')) throw new Error('未找到 macOS 音频播放程序 /usr/bin/afplay');
      await waitChild(
        spawn('/usr/bin/afplay', ['-v', String(gain), file], {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        }),
        signal,
      );
      return;
    }
    if (process.platform === 'win32') {
      // SoundPlayer 不提供应用内音量控制，系统输出音量由操作系统控制。
      const binary = nativeBinary();
      if (!binary) throw new Error('未找到 Windows PowerShell 播放通道');
      // 路径经环境变量传入，避免命令行字符串拼接与注入。
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$p = New-Object System.Media.SoundPlayer',
        '$p.SoundLocation = $env:AWM_PLAY_FILE',
        '$p.PlaySync()',
        '$p.Dispose()',
      ].join('; ');
      const child = spawn(binary, ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: { ...process.env, AWM_PLAY_FILE: file },
      });
      await waitChild(child, signal);
      return;
    }
    const player = findBinary('paplay') ?? findBinary('aplay');
    if (!player) throw new Error('未找到 Linux 音频播放程序（paplay 或 aplay）');
    const args = player.endsWith('paplay')
      ? ['--volume=' + String(Math.round(gain * 65536)), '--', file]
      : ['-q', file];
    await waitChild(spawn(player, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }), signal);
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/** @description: 未提供模型与播放链时不能把合成输出当作播放成功。 */
export function createPiperBackend(): TtsBackend {
  const reason = 'Piper 尚未配置模型与音频播放，当前不可用';
  return {
    name: 'piper',
    unavailableReason: reason,
    isAvailable: () => false,
    speak: () => Promise.reject(new Error(reason)),
  };
}

/** 小米 MiMo 开放平台的默认参数；仅在用户显式开启云 TTS 并填写 Key 后才会请求。 */
// 地址与设置默认值共用一处，避免设置页显示的和实际请求的不是同一个地址。
export const MIMO_TTS_ENDPOINT = DEFAULT_CLOUD_ENDPOINT;
export const MIMO_TTS_MODEL = 'mimo-v2.5-tts';
// 官方预置音色：mimo_default（随集群，中文集群为冰糖）+ 4 个中文 + 4 个英文。
export const MIMO_TTS_VOICE = 'mimo_default';
/** MiMo 预置音色；设置页按下拉选择，默认值必须在这份列表里。 */
export const MIMO_TTS_VOICES = [
  'mimo_default',
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean',
] as const;
const CLOUD_TIMEOUT_MS = 30_000;
const CLOUD_ERROR_LIMIT = 300;
const DEFAULT_CLOUD_STYLE = '用平稳清晰的播报语气，语速适中，不要加入额外内容。';

export interface CloudTtsConfig {
  /** 必须由用户显式开启；关闭时不发请求。 */
  enabled: boolean;
  /** 完整 POST 地址；空则使用 MiMo 官方地址。 */
  endpoint?: string;
  /** API Key；空则后端不可用。 */
  apiKey?: string;
  model?: string;
  voice?: string;
  /** 风格指令放在 user 消息，待播报文本放在 assistant 消息。 */
  style?: string;
}

/** @description: 从 OpenAI 兼容响应中取出 base64 音频；兼容单条与多条 choices。 */
function cloudAudioData(body: unknown): string | undefined {
  const choices = (body as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return undefined;
  for (const choice of choices) {
    const data = (choice as { message?: { audio?: { data?: unknown } } } | null)?.message?.audio
      ?.data;
    if (typeof data === 'string' && data.trim()) return data;
  }
  return undefined;
}

/**
 * 把设置里的接口地址补成实际 POST 的地址。
 * 文档给的是基础地址（`…/v1`、`…/anthropic` 或只有域名），而 TTS 走 OpenAI 兼容的
 * `/v1/chat/completions`；直接 POST 基础地址只会拿到网关 404。
 * 只补全这几种基础地址，其他路径视为完整地址，不擅自改写。
 * @param raw 用户填写的地址；空则用官方默认地址
 * @returns 可直接 POST 的完整地址
 */
export function resolveCloudEndpoint(raw?: string): string {
  const text = raw?.trim() || MIMO_TTS_ENDPOINT;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // 不是合法 URL 时原样返回，由 fetch 给出具体错误。
    return text;
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(path)) return url.toString();
  // /anthropic 是对话类客户端用的兼容入口，音频仍走 OpenAI 兼容路径。
  if (path === '' || path === '/v1' || path === '/anthropic') {
    url.pathname = '/v1/chat/completions';
    return url.toString();
  }
  return text;
}

/** @description: 云合成只返回错误文本，不透传请求头与完整响应体。 */
async function cloudFailure(response: Response): Promise<Error> {
  const raw = (await response.text().catch(() => '')).trim();
  // 网关 404 常见是整页 HTML，正文没有参考价值，只提示检查地址。
  const detail = raw && !raw.startsWith('<') ? raw.slice(0, CLOUD_ERROR_LIMIT) : '';
  const hint = response.status === 404 ? '，请确认接口地址指向 …/v1/chat/completions' : '';
  return new Error(`云 TTS 请求失败：HTTP ${response.status}${hint}${detail ? '：' + detail : ''}`);
}

/** @description: 请求云 TTS 并落盘为 WAV；超时、取消和 HTTP 错误都明确失败。 */
async function synthesizeCloud(
  config: CloudTtsConfig,
  options: SpeakOptions,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error('播报已打断');
  const endpoint = resolveCloudEndpoint(config.endpoint);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);
  timer.unref();
  let audio: Buffer | undefined;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey?.trim() ?? ''}`,
      },
      body: JSON.stringify({
        model: config.model?.trim() || MIMO_TTS_MODEL,
        messages: [
          { role: 'user', content: config.style?.trim() || DEFAULT_CLOUD_STYLE },
          { role: 'assistant', content: options.text },
        ],
        audio: { format: 'wav', voice: config.voice?.trim() || MIMO_TTS_VOICE },
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw await cloudFailure(response);
    const data = cloudAudioData(await response.json().catch(() => undefined));
    if (!data) throw new Error('云 TTS 响应缺少音频数据');
    audio = Buffer.from(data, 'base64');
  } catch (error) {
    if (signal?.aborted) throw new Error('播报已打断');
    if (controller.signal.aborted) throw new Error('云 TTS 请求超时（30 秒）');
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF')
    throw new Error('云 TTS 返回的音频不是 WAV，请检查模型与 format 参数');
  const directory = await mkdtemp(path.join(tmpdir(), 'awm-cloud-'));
  const file = path.join(directory, 'speech.wav');
  await writeFile(file, audio);
  return file;
}

/**
 * @description: 云 TTS（OpenAI 兼容，当前接小米 MiMo）。
 * 只在用户开启、填写 Key 且选择云后端时出网；失败直接返回原因，不静默换音色。
 */
export function createCloudBackend(config: CloudTtsConfig): TtsBackend {
  const unavailable = (): string | undefined => {
    if (!config.enabled) return '云 TTS 未开启';
    if (!config.apiKey?.trim()) return '云 TTS 未填写 API Key';
    return undefined;
  };
  return {
    name: 'cloud',
    get unavailableReason() {
      return unavailable();
    },
    isAvailable: () => unavailable() === undefined,
    async speak(options, signal) {
      const reason = unavailable();
      if (reason) throw new Error(reason);
      const file = await synthesizeCloud(config, options, signal);
      try {
        await playAudioFile(file, options.volume ?? 0.8, signal);
      } finally {
        await rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

export interface SpeakResult {
  ok: boolean;
  usedBackend?: string;
  errors: string[];
}

/** 依次尝试可播放的后端，串行等待被取消的旧播放退出。 */
export class TtsChain {
  private readonly backends: TtsBackend[];
  private abort: AbortController | null = null;
  private pending: Promise<SpeakResult> | null = null;

  constructor(backends: TtsBackend[]) {
    this.backends = backends;
  }

  /** @description: 打断当前或尚未开始的单次播报。 */
  cancel(): void {
    this.abort?.abort();
    this.abort = null;
  }

  /** @description: 新请求等待前一个被取消的播放结束，再取得播放器。 */
  async speak(options: SpeakOptions): Promise<SpeakResult> {
    this.cancel();
    const previous = this.pending;
    const controller = new AbortController();
    this.abort = controller;
    const operation = (async (): Promise<SpeakResult> => {
      if (previous) await previous;
      const errors: string[] = [];
      try {
        for (const backend of this.backends) {
          if (controller.signal.aborted) return { ok: false, errors: [...errors, '播报已打断'] };
          if (!backend.isAvailable()) {
            errors.push(backend.name + '：' + (backend.unavailableReason ?? '当前环境不可用'));
            continue;
          }
          try {
            await backend.speak(options, controller.signal);
            if (controller.signal.aborted) return { ok: false, errors: [...errors, '播报已打断'] };
            return { ok: true, usedBackend: backend.name, errors };
          } catch (error) {
            errors.push(
              backend.name + '：' + (error instanceof Error ? error.message : String(error)),
            );
          }
        }
        return { ok: false, errors };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return { ok: false, errors };
      } finally {
        if (this.abort === controller) this.abort = null;
      }
    })();
    this.pending = operation;
    try {
      return await operation;
    } finally {
      if (this.pending === operation) this.pending = null;
    }
  }
}
