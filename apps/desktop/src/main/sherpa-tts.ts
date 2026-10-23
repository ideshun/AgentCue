/**
 * sherpa-onnx 本地 TTS 后端（Kokoro 预置音色 / ZipVoice 零样本音色）。
 * 依赖 apps/desktop 直带原生包（core 保持零原生依赖），故落在此处实现 core 的 TtsBackend。
 * 原生库、引擎实例与模型加载均延迟到真正播报时发生：启动路径 createTtsChain 不得触发 dlopen。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { playAudioFile, type SpeakOptions, type TtsBackend } from '@awm/core';
import { buildKokoroPronunciationLexicon } from './kokoro-pronunciation';

/** 合成超时：onnxruntime 挂死会永久卡死串行播放链，必须在时限后返回明确错误。 */
const GENERATE_TIMEOUT_MS = 120_000;

/** Kokoro 多语言包内发音人编号区间（中文女声/男声）；缺省取首位女声 */
const DEFAULT_SID = 3;

/** ZipVoice 蒸馏模型的推荐步数；步数越高越慢，4 步已足够短播报。 */
const ZIPVOICE_NUM_STEPS = 4;

export type LocalEngine = 'kokoro' | 'zipvoice';

interface SherpaGenerated {
  samples: Float32Array;
  sampleRate: number;
}

type SherpaWave = SherpaGenerated;

interface SherpaGenerationConfig {
  sid?: number;
  speed?: number;
  silenceScale?: number;
  /** ZipVoice：参考音频采样（单声道）。 */
  referenceAudio?: Float32Array;
  referenceSampleRate?: number;
  /** ZipVoice：与参考音频逐字对应的文本。 */
  referenceText?: string;
  /** ZipVoice：扩散步数。 */
  numSteps?: number;
  /** ZipVoice：额外参数，例如 min_char_in_sentence。 */
  extra?: Record<string, string>;
}

interface SherpaModule {
  GenerationConfig: new (init?: SherpaGenerationConfig) => SherpaGenerationConfig;
  OfflineTts: {
    new (config: unknown): SherpaEngine;
    createAsync(config: unknown): Promise<SherpaEngine>;
  };
  writeWave(file: string, audio: SherpaGenerated): void;
  /** 1.13.x 起提供；用于读取 ZipVoice 的参考音频。 */
  readWave?(file: string): SherpaWave;
}

interface SherpaEngine {
  readonly numSpeakers: number;
  readonly sampleRate: number;
  generateAsync(request: {
    text: string;
    sid?: number;
    speed?: number;
    /** Copy samples into a JS-owned ArrayBuffer instead of adopting native memory. */
    enableExternalBuffer?: boolean;
    generationConfig?: SherpaGenerationConfig;
    onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void;
  }): Promise<SherpaGenerated>;
}

export interface SherpaBackendOptions {
  /** 模型目录；Kokoro 与 ZipVoice 各一个。 */
  modelDir: string;
  /** 本地引擎，缺省为 Kokoro（兼容旧调用）。 */
  engine?: LocalEngine;
  /** ZipVoice 必需：参考音频路径与逐字文本。 */
  zipvoice?: { referenceAudioPath: string; referenceText: string };
}

/** 引擎实例缓存：按"引擎 + 模型目录"单例，避免换链或多次 speak 重读数百 MB 模型 */
const engineCache = new Map<string, Promise<SherpaEngine>>();

/** 参考音频缓存：用户选择的文件会被复制到数据目录，路径即身份。 */
const referenceCache = new Map<string, SherpaWave>();

/** 原生运行时模块缓存；加载失败不缓存，下次 speak 重试 */
let modulePromise: Promise<SherpaModule> | null = null;

/**
 * @description: 动态 import 原生模块——启动路径 createTtsChain 不触发 dlopen；
 * 失败清空缓存以便重试（如缺失运行库时稍后装好）。
 */
function loadSherpa(): Promise<SherpaModule> {
  if (!modulePromise) {
    const resourcesPath = process.resourcesPath;
    const stagedPackage = resourcesPath
      ? path.join(resourcesPath, 'sherpa-tts/node_modules/sherpa-onnx-node/package.json')
      : undefined;
    modulePromise = (
      stagedPackage && existsSync(stagedPackage)
        ? Promise.resolve().then(
            () =>
              createRequire(path.join(resourcesPath, 'sherpa-tts/package.json'))(
                'sherpa-onnx-node',
              ) as SherpaModule,
          )
        : import('sherpa-onnx-node').then((module) => module as unknown as SherpaModule)
    ).catch((error: unknown) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

/** @description: 解析保存的 profile 为合法发音人编号；kokoro:<sid> 直通，未知或越界回落首位女声。 */
function resolveSid(profile: string | undefined, numSpeakers: number): number {
  if (profile?.startsWith('kokoro:')) {
    const parsed = Number.parseInt(profile.slice('kokoro:'.length), 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed < numSpeakers) return parsed;
  }
  return Math.min(DEFAULT_SID, Math.max(0, numSpeakers - 1));
}

/** @description: Kokoro 配置：先加载带开发词校正的临时词典，再加载模型原词典。 */
async function createKokoroEngine(module: SherpaModule, modelDir: string): Promise<SherpaEngine> {
  const source = await readFile(path.join(modelDir, 'lexicon-zh.txt'), 'utf8');
  const corrections = buildKokoroPronunciationLexicon(source);
  const directory = await mkdtemp(path.join(tmpdir(), 'awm-kokoro-lexicon-'));
  const override = path.join(directory, 'pronunciation.txt');
  try {
    await writeFile(override, corrections, 'utf8');
    const config = {
      model: {
        kokoro: {
          model: path.join(modelDir, 'model.onnx'),
          voices: path.join(modelDir, 'voices.bin'),
          tokens: path.join(modelDir, 'tokens.txt'),
          dataDir: path.join(modelDir, 'espeak-ng-data'),
          lexicon: [
            // Sherpa 对重复词采用首次定义；词级校正必须先于模型原词典加载。
            override,
            path.join(modelDir, 'lexicon-us-en.txt'),
            path.join(modelDir, 'lexicon-zh.txt'),
          ].join(','),
        },
        numThreads: 2,
        provider: 'cpu',
      },
      maxNumSentences: 1,
    };
    return await module.OfflineTts.createAsync(config);
  } finally {
    // 引擎初始化完成后，词典已读入内存；不修改用户下载的模型文件。
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * @description: ZipVoice 配置。模型包不自带声码器与英文词典，管理器会把它们
 * 放进同一目录；没有预置发音人，音色完全由每次合成的参考音频决定。
 */
async function createZipvoiceEngine(module: SherpaModule, modelDir: string): Promise<SherpaEngine> {
  const config = {
    model: {
      zipvoice: {
        encoder: path.join(modelDir, 'encoder.int8.onnx'),
        decoder: path.join(modelDir, 'decoder.int8.onnx'),
        vocoder: path.join(modelDir, 'vocos_24khz.onnx'),
        tokens: path.join(modelDir, 'tokens.txt'),
        lexicon: [
          path.join(modelDir, 'lexicon.txt'),
          path.join(modelDir, 'lexicon-en-us.txt'),
        ].join(','),
      },
      numThreads: 2,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  };
  return module.OfflineTts.createAsync(config);
}

/** @description: 取得（必要时异步创建）该模型目录的引擎实例。 */
function getEngine(
  module: SherpaModule,
  engine: LocalEngine,
  modelDir: string,
): Promise<SherpaEngine> {
  const key = engine + ':' + modelDir;
  let instance = engineCache.get(key);
  if (!instance) {
    instance = (engine === 'zipvoice'
      ? createZipvoiceEngine(module, modelDir)
      : createKokoroEngine(module, modelDir)
    ).catch((error: unknown) => {
      // 创建失败清缓存，下次 speak 重新尝试（如临时内存不足）。
      engineCache.delete(key);
      throw error;
    });
    engineCache.set(key, instance);
  }
  return instance;
}

/** @description: 读取并缓存 ZipVoice 参考音频；文件被替换后由调用方重启应用生效。 */
function readReference(module: SherpaModule, file: string): SherpaWave {
  const cached = referenceCache.get(file);
  if (cached) return cached;
  if (!module.readWave) throw new Error('当前 sherpa-onnx-node 版本不支持读取参考音频');
  const wave = module.readWave(file);
  if (!wave.samples?.length || !wave.sampleRate)
    throw new Error('参考音频为空或格式不受支持，请选择 16kHz 以上的 WAV');
  referenceCache.set(file, wave);
  return wave;
}

/**
 * @description: 带超时与取消早停的合成。cancel 通过 onProgress 返回 false 停止后续句子；
 * 超时则放弃等待（结果标记 stale 后不得继续播放）。
 */
async function generateWithGuard(
  engine: SherpaEngine,
  GenerationConfig: SherpaModule['GenerationConfig'],
  text: string,
  generation: SherpaGenerationConfig,
  signal: AbortSignal | undefined,
): Promise<SherpaGenerated> {
  let cancelled = false;
  const stop = (): void => {
    cancelled = true;
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) cancelled = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const work = engine.generateAsync({
      text,
      generationConfig: new GenerationConfig(generation),
      // The native addon's external ArrayBuffer handoff can fail during Promise
      // settlement in Electron. Keep the result in a JS-owned buffer instead.
      enableExternalBuffer: false,
      onProgress: () => (cancelled ? false : 1),
    });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        cancelled = true;
        resolve(null);
      }, GENERATE_TIMEOUT_MS);
    });
    const result = await Promise.race([work, timeout]);
    if (timedOut) {
      // 超时后合成结果不再使用；吞掉迟到的 reject 避免 unhandled rejection。
      work.catch(() => undefined);
      throw new Error('本地语音合成超时（120 秒）');
    }
    if (signal?.aborted) throw new Error('播报已打断');
    return result as SherpaGenerated;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/**
 * @description: 创建 sherpa-onnx 本地播放后端。isAvailable 每次动态检查模型目录，
 * 使下载完成后无需重建播放链即可生效；音色与语速从入参读取，不闭包 settings。
 */
export function createSherpaBackend(options: SherpaBackendOptions): TtsBackend {
  const modelDir = options.modelDir;
  const engineName: LocalEngine = options.engine ?? 'kokoro';
  const isZipvoice = engineName === 'zipvoice';
  const label = isZipvoice ? 'ZipVoice' : 'Kokoro';
  return {
    name: 'local',
    unavailableReason: `本地 ${label} 模型未下载或原生运行时不可用`,
    // 仅动态判模型目录：下载完成后无需重建播放链；运行时加载失败由所选后端返回错误。
    isAvailable: () => existsSync(modelDir),
    async speak(speak: SpeakOptions, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) throw new Error('播报已打断');
      if (!existsSync(modelDir)) throw new Error(`本地 ${label} 模型未下载`);
      let reference: { audio: SherpaWave; text: string } | undefined;
      if (isZipvoice) {
        const audioPath = options.zipvoice?.referenceAudioPath?.trim() ?? '';
        const referenceText = options.zipvoice?.referenceText?.trim() ?? '';
        if (!audioPath || !existsSync(audioPath))
          throw new Error('ZipVoice 需要参考音频：请在设置中选择一段清晰的 WAV 录音');
        if (!referenceText) throw new Error('ZipVoice 需要与参考音频逐字对应的文本');
        reference = { audio: { samples: new Float32Array(0), sampleRate: 0 }, text: referenceText };
      }
      let module: SherpaModule;
      try {
        module = await loadSherpa();
      } catch (error) {
        throw new Error(
          '未安装 sherpa-onnx-node 原生运行时：' +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      if (reference) {
        const audioPath = options.zipvoice!.referenceAudioPath.trim();
        reference.audio = readReference(module, audioPath);
      }
      const engine = await getEngine(module, engineName, modelDir);
      const speed = Math.min(2, Math.max(0.5, speak.rate ?? 1));
      const generation: SherpaGenerationConfig = reference
        ? {
            speed,
            numSteps: ZIPVOICE_NUM_STEPS,
            referenceAudio: reference.audio.samples,
            referenceSampleRate: reference.audio.sampleRate,
            referenceText: reference.text,
            extra: { min_char_in_sentence: '10' },
          }
        : { speed, sid: resolveSid(speak.voiceProfile, engine.numSpeakers) };
      const audio = await generateWithGuard(
        engine,
        module.GenerationConfig,
        speak.text,
        generation,
        signal,
      );
      // 空样本不得报成功——对齐"未真实播放不报成功"契约与 hasAiffSpeech 先例。
      if (!audio || audio.samples.length === 0) throw new Error('本地语音未生成有效音频');
      if (signal?.aborted) throw new Error('播报已打断');
      const directory = await mkdtemp(path.join(tmpdir(), 'awm-local-'));
      const file = path.join(directory, 'speech.wav');
      try {
        module.writeWave(file, { samples: audio.samples, sampleRate: audio.sampleRate });
        await playAudioFile(file, speak.volume ?? 0.8, signal);
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
