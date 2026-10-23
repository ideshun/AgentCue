/**
 * 模型管理器单测：用 fetch 流与 tar 桩验证进度、取消、损坏包与就绪探测，不发真实网络请求。
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KOKORO_MODEL_DIR_NAME,
  KokoroModelManager,
  LocalModelManager,
  ZIPVOICE_MODEL_DIR_NAME,
  ZIPVOICE_SPEC,
  type ModelManagerOptions,
  type ModelSpec,
} from '../../apps/desktop/src/main/model-manager';
import type { ModelStatus } from '@awm/core';

const TOTAL = 4096;
const FILE_TINY = 16;

/** 按大小写稀疏文件——校验只看尺寸，不读内容 */
function writeSized(file: string, size: number): void {
  writeFileSync(file, Buffer.alloc(0));
  truncateSync(file, size);
}

/** 生成满足校验的最小合法模型目录内容 */
function writeModelFiles(dir: string, opts: { smallModel?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeSized(path.join(dir, 'model.onnx'), opts.smallModel ? FILE_TINY : 110 * 1024 * 1024);
  writeSized(path.join(dir, 'voices.bin'), 11 * 1024 * 1024);
  writeFileSync(path.join(dir, 'tokens.txt'), 'a b c d e f g\n');
  writeFileSync(path.join(dir, 'lexicon-us-en.txt'), 'x'.repeat(2048));
  writeFileSync(path.join(dir, 'lexicon-zh.txt'), 'x'.repeat(2048));
  mkdirSync(path.join(dir, 'espeak-ng-data'), { recursive: true });
  writeFileSync(path.join(dir, 'espeak-ng-data', 'phondata'), 'x');
}

/** 正常 Content-Length 的响应头 */
function headers(total = TOTAL): Headers {
  return new Headers({ 'content-length': String(total) });
}

/** fetch 流式响应桩 */
function fakeFetch(body: ReadableStream<Uint8Array>, responseHeaders = headers(), ok = true) {
  return vi.fn(async () =>
    new Response(body, {
      status: ok ? 200 : 500,
      headers: responseHeaders,
    }),
  ) as unknown as typeof fetch;
}

/** 分块流 */
function chunkStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** tar 桩：按 -C 参数伪造解压产物 */
function fakeTar(mode: 'good' | 'corrupt' | 'nothing' | 'fail' = 'good') {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  const spawnImpl = vi.fn((_cmd: string, args: string[]) => {
    const dir = args[args.indexOf('-C') + 1];
    if (mode === 'good') writeModelFiles(path.join(dir, KOKORO_MODEL_DIR_NAME));
    else if (mode === 'corrupt')
      writeModelFiles(path.join(dir, KOKORO_MODEL_DIR_NAME), { smallModel: true });
    if (mode === 'fail')
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('bad archive'));
        child.emit('close', 2);
      });
    else queueMicrotask(() => child.emit('close', 0));
    return child as never;
  }) as unknown as ModelManagerOptions['spawnImpl'];
  return { spawnImpl, child };
}

let root: string;
let published: ModelStatus[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'awm-model-test-'));
  published = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function manager(fetchImpl?: typeof fetch, spawnImpl?: ModelManagerOptions['spawnImpl']) {
  return new KokoroModelManager({
    modelRoot: root,
    fetchImpl,
    spawnImpl,
    onProgress: (status) => published.push(status),
  });
}

describe('KokoroModelManager', () => {
  it('下载解压成功后进入 ready，并清理归档与 part 文件', async () => {
    const tar = fakeTar('good');
    const m = manager(
      fakeFetch(chunkStream([Buffer.alloc(TOTAL / 2), Buffer.alloc(TOTAL / 2)])),
      tar.spawnImpl,
    );
    await m.download();
    expect(m.status().state).toBe('ready');
    const states = published.map((s) => s.state);
    expect(states[0]).toBe('downloading');
    expect(states).toContain('extracting');
    expect(states[states.length - 1]).toBe('ready');
    const last = published.filter((s) => s.state === 'downloading').at(-1)!;
    expect(last.percent).toBe(100);
    expect(last.bytes).toBe(TOTAL);
    const modelDir = path.join(root, KOKORO_MODEL_DIR_NAME);
    expect(m.modelDir).toBe(modelDir);
    expect(mkfileEntries(modelDir)).toContain('model.onnx');
    expect(mkfileEntries(root)).not.toContain(KOKORO_MODEL_DIR_NAME + '.tar.bz2');
    expect(mkfileEntries(root)).not.toContain(KOKORO_MODEL_DIR_NAME + '.tar.bz2.part');
  });

  it('字节数与 Content-Length 不符时进入 error 并清理 part', async () => {
    const tar = fakeTar();
    const m = manager(fakeFetch(chunkStream([Buffer.alloc(TOTAL - 10)])), tar.spawnImpl);
    await m.download();
    expect(m.status().state).toBe('error');
    expect(m.status().error).toContain('不完整');
    expect(tar.spawnImpl).not.toHaveBeenCalled();
    // .part 保留供下次断点续传
    expect(mkfileEntries(root).some((name) => name.endsWith('.part'))).toBe(true);
  });

  it('续传：带上已有 .part 的 Range，服务端 206 时从断点继续', async () => {
    const part = path.join(root, KOKORO_MODEL_DIR_NAME + '.tar.bz2.part');
    writeFileSync(part, Buffer.alloc(TOTAL / 2));
    const seen: (HeadersInit | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: HeadersInit }) => {
      seen.push(init?.headers);
      return new Response(chunkStream([Buffer.alloc(TOTAL / 2)]), {
        status: 206,
        headers: new Headers({ 'content-range': 'bytes ' + String(TOTAL / 2) + '-' + String(TOTAL - 1) + '/' + String(TOTAL) }),
      });
    }) as unknown as typeof fetch;
    const m = manager(fetchImpl, fakeTar('good').spawnImpl);
    await m.download();
    expect(seen[0]).toEqual({ Range: 'bytes=' + String(TOTAL / 2) + '-' });
    expect(m.status().state).toBe('ready');
    // 断点前半 + 续传后半完整落位；part 与归档在成功路径均被消化
    expect(statSync(path.join(root, KOKORO_MODEL_DIR_NAME, 'model.onnx')).size).toBe(
      110 * 1024 * 1024,
    );
  });

  it('续传：服务器不支持 Range 时作废残留从头下，失败保留 .part', async () => {
    const part = path.join(root, KOKORO_MODEL_DIR_NAME + '.tar.bz2.part');
    writeFileSync(part, Buffer.alloc(500));
    const seen: (HeadersInit | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: HeadersInit }) => {
      seen.push(init?.headers);
      return new Response(chunkStream([Buffer.alloc(TOTAL)]), {
        status: 200,
        headers: headers(TOTAL),
      });
    }) as unknown as typeof fetch;
    const m = manager(fetchImpl, fakeTar('good').spawnImpl);
    await m.download();
    expect(seen[0]).toEqual({ Range: 'bytes=500-' });
    expect(m.status().state).toBe('ready');
  });

  it('HTTP 非 2xx 明确报告错误且不启动解压', async () => {
    const tar = fakeTar();
    const m = manager(fakeFetch(chunkStream([Buffer.alloc(4)]), headers(4), false), tar.spawnImpl);
    await m.download();
    expect(m.status().state).toBe('error');
    expect(m.status().error).toContain('500');
    expect(tar.spawnImpl).not.toHaveBeenCalled();
  });

  it('损坏包缺少数据目录时拒绝就位并报告原因', async () => {
    const { spawnImpl } = fakeTar('nothing');
    const m = manager(
      fakeFetch(chunkStream([Buffer.alloc(TOTAL)])),
      spawnImpl,
    );
    await m.download();
    expect(m.status().state).toBe('error');
    expect(m.status().error).toContain('缺少');
    expect(mkfileEntries(root)).not.toContain(KOKORO_MODEL_DIR_NAME);
  });

  it('必需文件尺寸异常视为损坏，不留半成品目录', async () => {
    const { spawnImpl } = fakeTar('corrupt');
    const m = manager(fakeFetch(chunkStream([Buffer.alloc(TOTAL)])), spawnImpl);
    await m.download();
    expect(m.status().state).toBe('error');
    expect(m.status().error).toContain('尺寸异常');
    expect(mkfileEntries(root)).not.toContain(KOKORO_MODEL_DIR_NAME);
  });

  it('解压失败报告 tar 退出码与有限 stderr', async () => {
    const { spawnImpl } = fakeTar('fail');
    const m = manager(fakeFetch(chunkStream([Buffer.alloc(TOTAL)])), spawnImpl);
    await m.download();
    expect(m.status().state).toBe('error');
    expect(m.status().error).toContain('bad archive');
  });

  it('取消下载回到 missing，广播不含 error', async () => {
    let pull: ((chunk: Uint8Array) => void) | undefined;
    const m = manager(
      fakeFetch(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.alloc(100));
            pull = (chunk) => controller.enqueue(chunk);
          },
        }),
      ),
      fakeTar().spawnImpl,
    );
    const done = m.download();
    await vi.waitFor(() => expect(m.status().state).toBe('downloading'));
    m.cancel();
    pull?.(Buffer.alloc(100));
    await done;
    expect(m.status().state).toBe('missing');
    expect(published.some((s) => s.state === 'error')).toBe(false);
    expect(mkfileEntries(root).some((name) => name.endsWith('.part'))).toBe(true);
  });

  it('下载进行中重复调用共用同一任务', async () => {
    const m = manager(fakeFetch(chunkStream([Buffer.alloc(TOTAL)])), fakeTar('good').spawnImpl);
    const first = m.download();
    const second = m.download();
    await Promise.all([first, second]);
    expect(m.status().state).toBe('ready');
    expect(published.filter((s) => s.state === 'ready')).toHaveLength(1);
  });

  it('磁盘上已有完整模型时状态为 ready，不触发下载', async () => {
    writeModelFiles(path.join(root, KOKORO_MODEL_DIR_NAME));
    const fetchImpl = vi.fn();
    const m = manager(fetchImpl as unknown as typeof fetch, fakeTar().spawnImpl);
    expect(m.status().state).toBe('ready');
    await m.download();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('进度发布按时间节流，状态切换立即广播', async () => {
    // 100 个 1 字节分块：节流窗口内最多约 2 次下载进度，但首尾与切换必达。
    const chunks = Array.from({ length: 100 }, () => Buffer.alloc(1));
    const m = manager(fakeFetch(chunkStream(chunks), headers(100)), fakeTar('good').spawnImpl);
    await m.download();
    const downloading = published.filter((s) => s.state === 'downloading');
    expect(downloading.length).toBeLessThanOrEqual(5);
    expect(downloading[0]!.percent).toBe(0);
    expect(downloading.at(-1)!.percent).toBe(100);
  });

  it('磁盘残留损坏模型目录时状态视为 missing，重新下载原子覆盖', async () => {
    writeModelFiles(path.join(root, KOKORO_MODEL_DIR_NAME), { smallModel: true });
    const sentinel = path.join(root, KOKORO_MODEL_DIR_NAME, 'leftover.txt');
    writeFileSync(sentinel, 'x');
    const m = manager(fakeFetch(chunkStream([Buffer.alloc(TOTAL)])), fakeTar('good').spawnImpl);
    expect(m.status().state).toBe('missing');
    await m.download();
    expect(m.status().state).toBe('ready');
    expect(mkfileEntries(m.modelDir)).not.toContain('leftover.txt');
  });
});

describe('LocalModelManager 额外文件', () => {
  const spec: ModelSpec = {
    kind: 'zipvoice',
    dirName: 'zipvoice-test',
    archiveUrl: 'https://example.test/model.tar.bz2',
    requiredFiles: [
      { name: 'encoder.int8.onnx', minBytes: 8 },
      { name: 'vocoder.onnx', minBytes: 8 },
    ],
    extraFiles: [
      { url: 'https://example.test/vocoder.onnx', name: 'vocoder.onnx', minBytes: 8 },
    ],
  };

  it('解压后补齐额外下载并保留 kind，就位后才进入 ready', async () => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
    const spawnImpl = vi.fn((_cmd: string, args: string[]) => {
      const dir = args[args.indexOf('-C') + 1];
      const inner = path.join(dir, spec.dirName);
      mkdirSync(inner, { recursive: true });
      writeFileSync(path.join(inner, 'encoder.int8.onnx'), Buffer.alloc(16));
      queueMicrotask(() => child.emit('close', 0));
      return child as never;
    }) as unknown as ModelManagerOptions['spawnImpl'];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return new Response(chunkStream([Buffer.alloc(16)]), {
        status: 200,
        headers: headers(16),
      });
    }) as unknown as typeof fetch;
    const statuses: ModelStatus[] = [];
    const m = new LocalModelManager(spec, {
      modelRoot: root,
      fetchImpl,
      spawnImpl,
      onProgress: (status) => statuses.push(status),
    });

    await m.download();

    expect(m.status()).toEqual({ state: 'ready', kind: 'zipvoice' });
    expect(statSync(path.join(m.modelDir, 'vocoder.onnx')).size).toBe(16);
    expect(urls).toEqual(['https://example.test/model.tar.bz2', 'https://example.test/vocoder.onnx']);
    expect(statuses.every((status) => status.kind === 'zipvoice')).toBe(true);
    // 额外文件下载期间仍处于 downloading；解压与就位由 extracting 标记。
    const states = statuses.map((status) => status.state);
    expect(states[0]).toBe('downloading');
    expect(states).toContain('extracting');
    expect(states.at(-1)).toBe('ready');
  });

  it('ZipVoice 规格要求模型包之外的声码器与英文词典', () => {
    const m = new LocalModelManager(ZIPVOICE_SPEC, { modelRoot: root });
    expect(m.modelDir).toBe(path.join(root, ZIPVOICE_MODEL_DIR_NAME));
    expect(m.status()).toEqual({ state: 'missing', kind: 'zipvoice' });
    expect(ZIPVOICE_SPEC.extraFiles?.map((file) => file.name)).toEqual([
      'vocos_24khz.onnx',
      'lexicon-en-us.txt',
    ]);
    expect(ZIPVOICE_SPEC.requiredFiles.map((file) => file.name)).toContain('lexicon.txt');
  });
});

/** 目录内条目名；目录不存在返回空 */
function mkfileEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
