/**
 * 本地语音模型管理器：仅在用户显式触发时下载与解压，默认不联网取包；失败不自动重试。
 * 纯 Node 实现（不 import electron），数据目录由构造传入，便于一次性脚本与单测复用。
 * 瞬态状态经 onProgress 回调广播 SSE，不进 settings。
 *
 * 目前管理两种模型：
 * - Kokoro（默认本地引擎，单包 tar.bz2）
 * - ZipVoice（零样本音色，模型包 + 声码器 + 英文词典三个下载）
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ModelStatus } from '@awm/core';

/** 模型目录名（tar 包顶层目录同名） */
export const KOKORO_MODEL_DIR_NAME = 'kokoro-multi-lang-v1_1';
export const ZIPVOICE_MODEL_DIR_NAME = 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia';

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;
/** 进度广播节流，避免高频 SSE 触发控制 API 限流 */
const PROGRESS_INTERVAL_MS = 500;
/** 错误消息长度上限 */
const ERROR_LIMIT = 200;

export type ModelKind = 'kokoro' | 'zipvoice';

/** 单个模型的下载与完整性描述。 */
export interface ModelSpec {
  kind: ModelKind;
  /** 解压后的目录名，同时作为 tar 顶层目录名 */
  dirName: string;
  /** 主模型包地址（tar.bz2） */
  archiveUrl: string;
  /** 解压后必需的文件与最小尺寸 */
  requiredFiles: ReadonlyArray<{ name: string; minBytes: number }>;
  /** 解压后必需的目录 */
  requiredDirs?: readonly string[];
  /** 模型包之外的直接下载文件，解压后放入模型目录 */
  extraFiles?: ReadonlyArray<{ url: string; name: string; minBytes: number }>;
}

/** Kokoro 多语言包（约 348MB；model.onnx 326MB、voices.bin 54MB、espeak-ng-data 18MB）。 */
export const KOKORO_SPEC: ModelSpec = {
  kind: 'kokoro',
  dirName: KOKORO_MODEL_DIR_NAME,
  archiveUrl:
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2',
  requiredFiles: [
    { name: 'model.onnx', minBytes: 100 * 1024 * 1024 },
    { name: 'voices.bin', minBytes: 10 * 1024 * 1024 },
    { name: 'tokens.txt', minBytes: 10 },
    { name: 'lexicon-us-en.txt', minBytes: 1024 },
    { name: 'lexicon-zh.txt', minBytes: 1024 },
  ],
  requiredDirs: ['espeak-ng-data'],
};

/**
 * ZipVoice 蒸馏 int8 中文/英文零样本模型（模型包约 104MB，另加声码器约 52MB
 * 与英文词典约 6MB）。它没有预置发音人编号，每次合成都需要参考音频与对应文本。
 */
export const ZIPVOICE_SPEC: ModelSpec = {
  kind: 'zipvoice',
  dirName: ZIPVOICE_MODEL_DIR_NAME,
  archiveUrl:
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2',
  requiredFiles: [
    { name: 'encoder.int8.onnx', minBytes: 2 * 1024 * 1024 },
    { name: 'decoder.int8.onnx', minBytes: 2 * 1024 * 1024 },
    { name: 'tokens.txt', minBytes: 10 },
    { name: 'lexicon.txt', minBytes: 1024 },
    { name: 'vocos_24khz.onnx', minBytes: 40 * 1024 * 1024 },
    { name: 'lexicon-en-us.txt', minBytes: 1024 * 1024 },
  ],
  extraFiles: [
    {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx',
      name: 'vocos_24khz.onnx',
      minBytes: 40 * 1024 * 1024,
    },
    {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/lexicon-en-us.txt',
      name: 'lexicon-en-us.txt',
      minBytes: 1024 * 1024,
    },
  ],
};

export interface ModelManagerOptions {
  /** models 根目录（通常是 userData/models） */
  modelRoot: string;
  /** 状态变化与下载进度回调；宿主负责 SSE 广播 */
  onProgress?: (status: ModelStatus) => void;
  /** 注入 fetch 便于单测；默认全局实现 */
  fetchImpl?: typeof fetch;
  /** 注入 spawn 便于单测；默认 child_process.spawn */
  spawnImpl?: (command: string, args: string[], options?: SpawnOptions) => ChildProcess;
}

/** @description: 同步校验模型目录完整性，缺失返回原因，完整返回 null。 */
function inspectModelDir(dir: string, spec: ModelSpec): string | null {
  for (const file of spec.requiredFiles) {
    const target = path.join(dir, file.name);
    let size = -1;
    try {
      size = existsSync(target) ? statSync(target).size : -1;
    } catch {
      size = -1;
    }
    if (size < 0) return '缺少模型文件 ' + file.name;
    if (size < file.minBytes)
      return '模型文件 ' + file.name + ' 尺寸异常（' + String(size) + ' 字节），疑似损坏';
  }
  for (const name of spec.requiredDirs ?? []) {
    const target = path.join(dir, name);
    if (!existsSync(target) || !statSync(target).isDirectory()) return '缺少 ' + name + ' 数据目录';
  }
  return null;
}

/** @description: 截断到 ERROR_LIMIT 的单行错误说明。 */
function limitedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, ERROR_LIMIT) || '未知错误';
}

/**
 * 管理单个模型包的下载、解压与状态广播。
 * 同一时刻仅允许一个任务；ready 后幂等。
 */
export class LocalModelManager {
  private readonly options: ModelManagerOptions;
  private readonly spec: ModelSpec;
  /** 内存态；missing 时按目录实况探测 */
  private current: ModelStatus = { state: 'missing' };
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  /** cancel() 与超时 abort 的区分标记 */
  private userCancelled = false;
  private lastProgressAt = 0;

  constructor(spec: ModelSpec, options: ModelManagerOptions) {
    this.spec = spec;
    this.options = options;
    this.current = { state: 'missing', kind: spec.kind };
  }

  /** 模型就绪后的目录 */
  get modelDir(): string {
    return path.join(this.options.modelRoot, this.spec.dirName);
  }

  /** @description: 当前状态；missing 内存态按目录文件实况探测（含上次会话遗留的完整模型）。 */
  status(): ModelStatus {
    if (this.current.state !== 'missing') return this.current;
    return { state: inspectModelDir(this.modelDir, this.spec) === null ? 'ready' : 'missing', kind: this.spec.kind };
  }

  /** @description: 用户显式触发的下载。即启即返的调用方用 void manager.download()。 */
  download(): Promise<void> {
    if (this.running) return this.running;
    if (this.status().state === 'ready') return Promise.resolve();
    this.userCancelled = false;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    this.running = this.run(controller.signal).finally(() => {
      clearTimeout(timeout);
      this.controller = null;
      this.running = null;
    });
    return this.running;
  }

  /** @description: 取消进行中的下载；清理 .part 后回到 missing。 */
  cancel(): void {
    this.userCancelled = true;
    this.controller?.abort();
  }

  /** @description: 串行执行下载→解压→校验→原子 rename；任何失败落 error 态且不自动重试。 */
  private async run(signal: AbortSignal): Promise<void> {
    const root = this.options.modelRoot;
    const archive = path.join(root, this.spec.dirName + '.tar.bz2');
    this.publish({ state: 'downloading', bytes: 0, totalBytes: 0, percent: 0 }, true);
    try {
      await mkdir(root, { recursive: true });
      await this.downloadToFile(this.spec.archiveUrl, archive, signal);
      await this.extract(archive, signal);
      await rm(archive, { force: true }).catch(() => undefined);
      this.publish({ state: 'ready' }, true);
    } catch (error) {
      // .part 保留供断点续传；仅在解压后或确认无法续传时清理。
      await rm(archive, { force: true }).catch(() => undefined);
      if (signal.aborted) {
        if (this.userCancelled) this.publish({ state: 'missing' }, true);
        else
          this.publish(
            { state: 'error', error: '下载超时（30 分钟），请检查网络后重试' },
            true,
          );
      } else {
        this.publish({ state: 'error', error: limitedError(error) }, true);
      }
    }
  }

  /** @description: 流式落盘 .part（支持断点续传），按总字节比对；完成后原子 rename 为正式归档。 */
  private async downloadToFile(url: string, archive: string, signal: AbortSignal): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const part = archive + '.part';
    let resumeFrom = await this.partSize(part);
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
      const current = resumeFrom;
      const fetched = await fetchImpl(url, {
        signal,
        redirect: 'follow',
        headers: current > 0 ? { Range: 'bytes=' + String(current) + '-' } : undefined,
      });
      if (fetched.status === 416 && current > 0) {
        // 残留 .part 越界（服务端文件已变化）：作废后整包重下。
        await rm(part, { force: true }).catch(() => undefined);
        resumeFrom = 0;
        continue;
      }
      if (!fetched.ok && fetched.status !== 206)
        throw new Error('下载失败：HTTP ' + String(fetched.status));
      if (current > 0 && fetched.status !== 206) {
        // 服务器不支持 Range（返回 200 整包）：从头覆盖。
        resumeFrom = 0;
      }
      response = fetched;
    }
    if (!response) throw new Error('下载失败：请求未发起');
    const body = response.body;
    if (!body) throw new Error('下载失败：响应没有内容');
    const contentRange = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '');
    const total = contentRange
      ? Number(contentRange[1])
      : (Number(response.headers.get('content-length') ?? '0') || 0) +
        (response.status === 206 ? resumeFrom : 0);
    const handle = await open(part, resumeFrom > 0 ? 'a' : 'w');
    try {
      const reader = body.getReader();
      let received = resumeFrom;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await handle.write(value);
          received += value.byteLength;
        }
        if (signal.aborted) throw new Error('下载已取消');
        const percent = total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0;
        this.publish({ state: 'downloading', bytes: received, totalBytes: total, percent });
      }
      if (total > 0 && received !== total)
        throw new Error('下载不完整：收到 ' + String(received) + ' / ' + String(total) + ' 字节');
      this.publish({ state: 'downloading', bytes: received, totalBytes: total, percent: 100 }, true);
    } finally {
      await handle.close().catch(() => undefined);
    }
    await rename(part, archive);
  }

  /** @description: 已有 .part 的字节数；不存在或不可读返回 0。 */
  private async partSize(part: string): Promise<number> {
    try {
      const size = (await stat(part)).size;
      return Number.isFinite(size) && size > 0 ? size : 0;
    } catch {
      return 0;
    }
  }

  /** @description: tar 解压到临时目录，补齐额外文件并校验后原子 rename 就位。 */
  private async extract(archive: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('下载已取消');
    this.publish({ state: 'extracting', percent: 100 }, true);
    const work = path.join(this.options.modelRoot, '.' + this.spec.kind + '-extract-' + String(Date.now()));
    await mkdir(work, { recursive: true });
    try {
      await this.runTar(['-xjf', archive, '-C', work], signal);
      const inner = path.join(work, this.spec.dirName);
      if (!existsSync(inner)) throw new Error('模型包缺少 ' + this.spec.dirName + ' 目录');
      for (const file of this.spec.extraFiles ?? []) {
        await this.downloadToFile(file.url, path.join(inner, file.name), signal);
      }
      const problem = inspectModelDir(inner, this.spec);
      if (problem) throw new Error('模型包' + problem + '，请重试下载');
      await rm(this.modelDir, { recursive: true, force: true });
      await rename(inner, this.modelDir);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** @description: 运行系统 tar（macOS bsdtar、Windows 10+ 与 Linux 均自带）；超时强杀。 */
  private runTar(args: string[], signal: AbortSignal): Promise<void> {
    const spawnImpl = this.options.spawnImpl ?? spawn;
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnImpl('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (error) {
        reject(new Error('无法启动 tar 解压：' + limitedError(error)));
        return;
      }
      let stderr = '';
      let settled = false;
      let failure: Error | undefined;
      const timeout = setTimeout(() => kill(child, new Error('解压超时（10 分钟）')), EXTRACT_TIMEOUT_MS);
      const abort = (): void => kill(child, new Error('已取消'));
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      function kill(target: ChildProcess, error: Error): void {
        if (failure) return;
        failure = error;
        target.kill('SIGKILL');
      }
      child.stderr?.on('data', (data: Buffer | string) => {
        stderr = (stderr + data.toString()).slice(-ERROR_LIMIT);
      });
      child.once('error', (error: Error) => finish(new Error('无法启动 tar 解压：' + error.message)));
      child.once('close', (code: number | null) => {
        if (failure) finish(failure);
        else if (code === 0) finish();
        else finish(new Error('tar 解压退出码 ' + String(code) + (stderr ? '：' + stderr : '')));
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  /** @description: 下载进度按 PROGRESS_INTERVAL_MS 节流；状态切换与关键节点立即发布。 */
  private publish(status: ModelStatus, force = false): void {
    const next: ModelStatus = { ...status, kind: this.spec.kind };
    this.current = next;
    if (!force && status.state === 'downloading') {
      const now = Date.now();
      if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
      this.lastProgressAt = now;
    } else if (status.state !== 'downloading') {
      this.lastProgressAt = 0;
    }
    try {
      this.options.onProgress?.(next);
    } catch {
      // 广播失败不影响下载任务本身
    }
  }
}

/** @description: Kokoro 模型管理器（保留原类名，默认使用 Kokoro 规格）。 */
export class KokoroModelManager extends LocalModelManager {
  constructor(options: ModelManagerOptions) {
    super(KOKORO_SPEC, options);
  }
}
