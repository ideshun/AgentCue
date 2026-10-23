/** 云 TTS 后端：只验证请求契约、错误映射与播放清理，不发起真实网络请求。 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCloudBackend,
  MIMO_TTS_ENDPOINT,
  MIMO_TTS_MODEL,
  resolveCloudEndpoint,
} from './tts';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  access: vi.fn(),
  mkdtemp: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }));
vi.mock('node:fs', () => ({ accessSync: mocks.access, constants: { F_OK: 0, X_OK: 1 } }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: mocks.mkdtemp,
  readFile: mocks.readFile,
  rm: mocks.rm,
  writeFile: mocks.writeFile,
}));

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

/** 构造带 RIFF 头的最小 WAV，仅用于格式校验。 */
function wav(): Buffer {
  const data = Buffer.alloc(48);
  data.write('RIFF', 0, 'ascii');
  data.writeUInt32LE(40, 4);
  data.write('WAVE', 8, 'ascii');
  data.write('data', 36, 'ascii');
  data.writeUInt32LE(4, 40);
  return data;
}

const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

/** 让响应返回指定的 JSON 与状态码。 */
function respond(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    })),
  );
}

const config = { enabled: true, apiKey: 'test-key' };

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
  mocks.access.mockReturnValue(undefined);
  mocks.mkdtemp.mockResolvedValue('/tmp/awm-cloud-test');
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  mocks.spawn.mockImplementation(() => {
    const child = new FakeChild();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', descriptor);
});

describe('resolveCloudEndpoint', () => {
  it('把文档里的基础地址补成实际 POST 的地址', () => {
    expect(resolveCloudEndpoint('')).toBe(MIMO_TTS_ENDPOINT);
    expect(resolveCloudEndpoint('  ')).toBe(MIMO_TTS_ENDPOINT);
    expect(resolveCloudEndpoint('https://api.xiaomimimo.com')).toBe(MIMO_TTS_ENDPOINT);
    expect(resolveCloudEndpoint('https://api.xiaomimimo.com/v1')).toBe(MIMO_TTS_ENDPOINT);
    expect(resolveCloudEndpoint('https://api.xiaomimimo.com/v1/')).toBe(MIMO_TTS_ENDPOINT);
    // /anthropic 是对话类客户端用的兼容入口，音频仍走 OpenAI 兼容路径。
    expect(resolveCloudEndpoint('https://api.xiaomimimo.com/anthropic')).toBe(MIMO_TTS_ENDPOINT);
    expect(resolveCloudEndpoint(MIMO_TTS_ENDPOINT)).toBe(MIMO_TTS_ENDPOINT);
    // 其他完整地址原样保留，不擅自拼接路径。
    expect(resolveCloudEndpoint('https://tts.example.com/v1/audio')).toBe(
      'https://tts.example.com/v1/audio',
    );
  });
});

describe('createCloudBackend', () => {
  it('未开启或缺少 Key 时明确不可用', () => {
    expect(createCloudBackend({ enabled: false, apiKey: 'k' }).isAvailable()).toBe(false);
    expect(createCloudBackend({ enabled: false }).unavailableReason).toContain('未开启');
    expect(createCloudBackend({ enabled: true }).unavailableReason).toContain('API Key');
    expect(createCloudBackend({ enabled: true, apiKey: ' ' }).isAvailable()).toBe(false);
  });

  it('按 OpenAI 兼容格式请求 MiMo 并播放返回的 WAV', async () => {
    const audio = wav().toString('base64');
    respond({ choices: [{ message: { audio: { data: audio } } }] });
    const backend = createCloudBackend(config);
    await backend.speak({ text: '任务完成', volume: 0.5 });

    const fetch = vi.mocked(globalThis.fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MIMO_TTS_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(MIMO_TTS_MODEL);
    expect(body.audio).toEqual({ format: 'wav', voice: 'mimo_default' });
    expect(body.messages.at(-1)).toEqual({ role: 'assistant', content: '任务完成' });
    expect(body.messages[0].role).toBe('user');

    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/tmp/awm-cloud-test/speech.wav',
      expect.any(Buffer),
    );
    const written = mocks.writeFile.mock.calls[0][1] as Buffer;
    expect(written.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(mocks.spawn).toHaveBeenCalledWith('/usr/bin/afplay', expect.any(Array), expect.anything());
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/awm-cloud-test', {
      recursive: true,
      force: true,
    });
  });

  it('响应缺少音频数据时失败，不播放', async () => {
    respond({ choices: [{ message: { content: '没有音频' } }] });
    await expect(createCloudBackend(config).speak({ text: '测试' })).rejects.toThrow(
      '缺少音频数据',
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('基础地址按 /v1/chat/completions 请求，避免网关 404', async () => {
    respond({ choices: [{ message: { audio: { data: wav().toString('base64') } } }] });
    await createCloudBackend({ ...config, endpoint: 'https://api.xiaomimimo.com/anthropic' }).speak({
      text: '测试',
    });
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
    expect(url).toBe(MIMO_TTS_ENDPOINT);
  });

  it('404 的 HTML 响应不原样显示，只提示检查接口地址', async () => {
    respond('<html><body><h1>404 Not Found</h1></body></html>', 404);
    const failure = await createCloudBackend(config)
      .speak({ text: '测试' })
      .catch((error: Error) => error);
    expect((failure as Error).message).toContain('HTTP 404');
    expect((failure as Error).message).toContain('…/v1/chat/completions');
    expect((failure as Error).message).not.toContain('<html>');
  });

  it('HTTP 错误只暴露状态码与截断后的响应文本', async () => {
    respond('invalid api key: sk-secret-should-not-leak'.repeat(40), 401);
    const failure = await createCloudBackend(config)
      .speak({ text: '测试' })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('HTTP 401');
    expect((failure as Error).message.length).toBeLessThan(400);
    expect((failure as Error).message).not.toContain('test-key');
  });

  it('返回非 WAV 内容时拒绝播放', async () => {
    respond({ choices: [{ message: { audio: { data: Buffer.from('not-a-wave').toString('base64') } } }] });
    await expect(createCloudBackend(config).speak({ text: '测试' })).rejects.toThrow('不是 WAV');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('播放前取消时直接返回打断，不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    respond({ choices: [] });
    await expect(
      createCloudBackend(config).speak({ text: '测试' }, controller.signal),
    ).rejects.toThrow('播报已打断');
  });
});
