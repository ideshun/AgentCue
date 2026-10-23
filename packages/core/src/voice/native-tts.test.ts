/** 原生播放用内存替身验证合成、有效音频、真实播放与清理，不发声音。 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCloudBackend,
  createNativeBackend,
  createPiperBackend,
  hasAiffSpeech,
  listNativeVoices,
  TtsChain,
} from './tts';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  access: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));
vi.mock('node:fs', () => ({ accessSync: mocks.access, constants: { F_OK: 0, X_OK: 1 } }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: mocks.mkdtemp,
  readFile: mocks.readFile,
  rm: mocks.rm,
}));

function aiff(silent = false): Buffer {
  const data = Buffer.alloc(58);
  data.write('FORM');
  data.writeUInt32BE(50, 4);
  data.write('AIFF', 8);
  data.write('COMM', 12);
  data.writeUInt32BE(18, 16);
  data.writeUInt16BE(1, 20);
  data.writeUInt32BE(2, 22);
  data.writeUInt16BE(16, 26);
  data.write('SSND', 38);
  data.writeUInt32BE(12, 42);
  if (!silent) {
    data[55] = 1;
    data[57] = 2;
  }
  return data;
}
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit('close', null));
    return true;
  });
}
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let children: FakeChild[] = [];
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
  children = [];
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  mocks.execFile.mockReset().mockImplementation((_binary, _args, _options, callback) => {
    callback(
      null,
      'Eddy (Chinese (China mainland)) zh_CN # 示例\nTingting (Chinese (China mainland)) zh_CN # 合成语音示例\nAlex en_US # Example\nSinji zh_HK # 粤语示例',
      '',
    );
  });
  mocks.access.mockReset().mockImplementation(() => undefined);
  mocks.mkdtemp.mockReset().mockResolvedValue('/tmp/awm-speech-fixture');
  mocks.readFile.mockReset().mockResolvedValue(aiff());
  mocks.rm.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', descriptor);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('native TTS subprocess', () => {
  it('中文自动选已安装音色，通过stdin合成，验证后播放并清理', async () => {
    const done = createNativeBackend().speak({ text: '-危险参数只是文字', rate: 1.2, volume: 0.7 });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/say',
      [
        '-r',
        '216',
        '-o',
        '/tmp/awm-speech-fixture/speech.aiff',
        '-v',
        'Eddy (Chinese (China mainland))',
      ],
      expect.any(Object),
    );
    expect(children[0].stdin.read().toString()).toBe('-危险参数只是文字');
    children[0].emit('close', 0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/afplay',
      ['-v', '0.7', '/tmp/awm-speech-fixture/speech.aiff'],
      expect.any(Object),
    );
    children[1].emit('close', 0);
    await expect(done).resolves.toBeUndefined();
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/awm-speech-fixture', {
      recursive: true,
      force: true,
    });
  });
  it('缺少系统程序时不创建子进程', async () => {
    mocks.access.mockImplementation(() => {
      throw new Error('missing');
    });
    expect(createNativeBackend().isAvailable()).toBe(false);
    await expect(createNativeBackend().speak({ text: '测试' })).rejects.toThrow('没有可用');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('退出0但只有静音或容器头不报告成功', async () => {
    mocks.readFile.mockResolvedValue(aiff(true));
    const done = createNativeBackend().speak({ text: '测试', voiceProfile: 'Tingting' });
    const checked = expect(done).rejects.toThrow('未生成有效音频');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit('close', 0);
    await checked;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalled();
  });
  it('非零退出报告有限stderr诊断', async () => {
    const done = createNativeBackend().speak({ text: '测试', voiceProfile: 'Tingting' });
    const checked = expect(done).rejects.toThrow('voice not found');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].stderr.write('voice not found');
    children[0].emit('close', 1);
    await checked;
    expect(mocks.rm).toHaveBeenCalled();
  });
  it('取消和超时终止进程并清理临时音频', async () => {
    const controller = new AbortController();
    const done = createNativeBackend().speak(
      { text: '测试', voiceProfile: 'Tingting' },
      controller.signal,
    );
    const checked = expect(done).rejects.toThrow('打断');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    controller.abort();
    await checked;
    expect(children[0].kill).toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
    vi.useFakeTimers();
    const timeout = createNativeBackend().speak({ text: '测试', voiceProfile: 'Tingting' });
    const timed = expect(timeout).rejects.toThrow('超时');
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    await timed;
    expect(children[1].kill).toHaveBeenCalled();
  });
  it('播放器失败不报告语音成功', async () => {
    const done = createNativeBackend().speak({ text: '测试', voiceProfile: 'Tingting' });
    const checked = expect(done).rejects.toThrow('audio device unavailable');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit('close', 0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].stderr.write('audio device unavailable');
    children[1].emit('close', 1);
    await checked;
    expect(mocks.rm).toHaveBeenCalled();
  });
  it('拒绝损坏或静音AIFF，接受有PCM数据的文件', () => {
    expect(hasAiffSpeech(Buffer.alloc(0))).toBe(false);
    expect(hasAiffSpeech(aiff().subarray(0, 50))).toBe(false);
    expect(hasAiffSpeech(aiff(true))).toBe(false);
    expect(hasAiffSpeech(aiff())).toBe(true);
  });
  it('缺少 API Key 的云后端明确不可用且不发请求', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const cloud = createCloudBackend({ enabled: true, endpoint: 'https://example.invalid/tts' });
    const piper = createPiperBackend();
    const result = await new TtsChain([cloud, piper]).speak({ text: '测试' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('API Key');
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe('native voice inventory', () => {
  it('按白名单与优先级过滤已安装中文音色，完整名称含括号且去重', async () => {
    mocks.execFile.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        null,
        [
          'Shelley (Chinese (China mainland))   zh_CN # 你好',
          'Tingting (Chinese (China mainland))   zh_CN # 你好',
          'Tingting (Chinese (China mainland))   zh_CN # 重复项',
          'Eddy (Chinese (Taiwan))              zh_TW # 台湾语区增强款：白名单不放行',
          'Sinji (Chinese (Hong Kong))          zh_HK # 你好',
          'Sinji (Chinese (Hong Kong))          zh_HK # 重复项',
          'Sinji                               en_US # Wrong language',
          'Grandma (Chinese (China mainland))   zh_CN # 未列入白名单',
          'Alex                                en_US # Example',
          'unrecognized line',
        ].join('\r\n'),
        '',
      );
    });
    await expect(listNativeVoices()).resolves.toEqual({
      voices: [
        {
          id: 'Shelley (Chinese (China mainland))',
          name: 'Shelley (Chinese (China mainland))',
          language: 'zh_CN',
        },
        {
          id: 'Tingting (Chinese (China mainland))',
          name: 'Tingting (Chinese (China mainland))',
          language: 'zh_CN',
        },
        {
          id: 'Sinji (Chinese (Hong Kong))',
          name: 'Sinji (Chinese (Hong Kong))',
          language: 'zh_HK',
        },
        // 英文音色只可手动选择，排在中文之后，不参与自动兜底。
        { id: 'Alex', name: 'Alex', language: 'en_US' },
      ],
    });
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/say',
      ['-v', '?'],
      { encoding: 'utf8', timeout: 3_000, maxBuffer: 256 * 1024 },
      expect.any(Function),
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('非macOS明确报告枚举不可用，不影响系统默认播放接口', async () => {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
    await expect(listNativeVoices()).resolves.toMatchObject({
      voices: [],
      error: expect.stringContaining('仍可使用系统默认语音'),
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
    const done = createNativeBackend().speak({ text: 'hello' });
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringContaining('espeak-ng'),
      ['--stdin', '-s', '175', '-a', '160'],
      expect.any(Object),
    );
    children[0].emit('close', 0);
    await done;
  });

  it('缺少say时报告诊断，不启动枚举', async () => {
    mocks.access.mockImplementation(() => {
      throw new Error('missing');
    });
    await expect(listNativeVoices()).resolves.toEqual({
      voices: [],
      error: '未找到 macOS 系统语音程序 /usr/bin/say',
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('空或未知输出明确报告错误', async () => {
    mocks.execFile.mockImplementation((_binary, _args, _options, callback) => {
      callback(null, 'unknown output', '');
    });
    await expect(listNativeVoices()).resolves.toEqual({
      voices: [],
      error:
        '本机未安装可用的系统中文音色，暂不能播放中文播报；可在系统语音设置下载增强语音，或改用本地 AI 语音',
    });
  });

  it('超时与子进程错误返回有限诊断，不拒绝列表请求', async () => {
    mocks.execFile.mockImplementationOnce((_binary, _args, _options, callback) => {
      callback(Object.assign(new Error('terminated'), { killed: true }), '', '');
    });
    await expect(listNativeVoices()).resolves.toEqual({
      voices: [],
      error: '读取系统音色超时（3 秒）',
    });
    mocks.execFile.mockImplementationOnce((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('failed'), {
          killed: true,
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }),
        '',
        'x'.repeat(3000) + ' voice service failed',
      );
    });
    const result = await listNativeVoices();
    expect(result.voices).toEqual([]);
    expect(result.error).toContain('voice service failed');
    expect(result.error!.length).toBeLessThan(2100);
    mocks.execFile.mockImplementationOnce(() => {
      throw new Error('cannot start');
    });
    await expect(listNativeVoices()).resolves.toEqual({
      voices: [],
      error: '无法读取系统音色：cannot start',
    });
  });

  it('自动中文和旧保存profile均回落已安装普通话增强音色，并传递完整可用名称', async () => {
    vi.resetModules();
    const { createNativeBackend: freshBackend } = await import('./tts');
    mocks.execFile.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        null,
        'Meijia zh_TW # 示例\nFlo (Chinese (China mainland)) zh_CN # 示例\nSinji (Chinese (Hong Kong)) zh_HK # 示例',
        '',
      );
    });
    const done = freshBackend().speak({ text: '中文测试' });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(mocks.spawn.mock.calls[0][1]).toContain('Flo (Chinese (China mainland))');
    children[0].emit('close', 0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].emit('close', 0);
    await done;
    mocks.execFile.mockClear();
    const selected = freshBackend().speak({
      text: '中文测试',
      voiceProfile: 'Eddy (Chinese (Taiwan))',
    });
    await vi.waitFor(() => expect(children).toHaveLength(3));
    expect(mocks.spawn.mock.calls[2][1]).toContain('Flo (Chinese (China mainland))');
    expect(mocks.spawn.mock.calls[2][1]).not.toContain('Eddy (Chinese (Taiwan))');
    children[2].emit('close', 0);
    await vi.waitFor(() => expect(children).toHaveLength(4));
    children[3].emit('close', 0);
    await selected;
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('自动选择遇到枚举错误可重试，不缓存失败', async () => {
    vi.resetModules();
    const { createNativeBackend: freshBackend } = await import('./tts');
    mocks.execFile.mockImplementationOnce((_binary, _args, _options, callback) => {
      callback(new Error('temporary failure'), '', '');
    });
    await expect(freshBackend().speak({ text: '中文测试' })).rejects.toThrow('temporary failure');
    expect(mocks.spawn).not.toHaveBeenCalled();
    const done = freshBackend().speak({ text: '中文测试' });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(mocks.spawn.mock.calls[0][1]).toContain('Eddy (Chinese (China mainland))');
    children[0].emit('close', 0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].emit('close', 0);
    await done;
  });

  it('纯英文自动试听也固定使用普通话增强音色，不回退系统默认音色', async () => {
    vi.resetModules();
    const { createNativeBackend: freshBackend } = await import('./tts');
    const done = freshBackend().speak({ text: 'Task completed', voiceProfile: 'system-default' });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(mocks.spawn.mock.calls[0][1]).toContain('-v');
    expect(mocks.spawn.mock.calls[0][1]).toContain('Eddy (Chinese (China mainland))');
    children[0].emit('close', 0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].emit('close', 0);
    await done;
  });

  it('白名单音色全部缺失时明确不可用，不退回其他中文或英文音色也不下载', async () => {
    vi.resetModules();
    const { createNativeBackend: freshBackend } = await import('./tts');
    mocks.execFile.mockImplementation((_binary, _args, _options, callback) => {
      callback(null, 'Grandma zh_CN # 未列入\nAlex en_US # Example', '');
    });
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(
      freshBackend().speak({ text: '中文测试', voiceProfile: 'Tingting' }),
    ).rejects.toThrow('系统中文音色');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.mkdtemp).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('保存的白名单音色婷婷命中直通，不再强制回落善怡', async () => {
    vi.resetModules();
    const { createNativeBackend: freshBackend } = await import('./tts');
    mocks.execFile.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        null,
        'Sinji (Chinese (Hong Kong)) zh_HK # 示例\nTingting (Chinese (China mainland)) zh_CN # 示例',
        '',
      );
    });
    const done = freshBackend().speak({ text: '中文测试', voiceProfile: 'Tingting (Chinese (China mainland))' });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(mocks.spawn.mock.calls[0][1]).toContain('Tingting (Chinese (China mainland))');
    expect(mocks.spawn.mock.calls[0][1]).not.toContain('Sinji (Chinese (Hong Kong))');
    children[0].emit('close', 0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].emit('close', 0);
    await done;
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('未知或未列入白名单的保存音色按优先级回落婷婷，Grandma不入选', async () => {
    vi.resetModules();
    const { createNativeBackend: freshBackend } = await import('./tts');
    mocks.execFile.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        null,
        'Grandma (Chinese (China mainland)) zh_CN # 未列入\nTingting (Chinese (China mainland)) zh_CN # 示例\nSinji (Chinese (Hong Kong)) zh_HK # 示例',
        '',
      );
    });
    const done = freshBackend().speak({ text: '中文测试', voiceProfile: 'Eddy (Chinese (Taiwan))' });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(mocks.spawn.mock.calls[0][1]).toContain('Tingting (Chinese (China mainland))');
    children[0].emit('close', 0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].emit('close', 0);
    await done;
  });
});
