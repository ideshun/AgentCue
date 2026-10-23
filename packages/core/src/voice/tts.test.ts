/**
 * TTS 降级链单测。
 * 使用假后端，不触发真实语音输出。
 */
import { describe, expect, it } from 'vitest';
import { announce } from './pipeline';
import { TtsChain, type TtsBackend } from './tts';

/** 构造假后端 */
function fakeBackend(
  name: string,
  options: { available?: boolean; fail?: boolean; spoken?: string[] } = {},
): TtsBackend {
  return {
    name,
    isAvailable() {
      return options.available ?? true;
    },
    async speak(speakOptions) {
      if (options.fail) {
        throw new Error(`${name} 故意失败`);
      }
      options.spoken?.push(speakOptions.text);
    },
  };
}

describe('TtsChain', () => {
  it('首个后端成功时直接返回', async () => {
    const spoken: string[] = [];
    const chain = new TtsChain([fakeBackend('first', { spoken }), fakeBackend('second')]);
    const result = await chain.speak({ text: '测试' });
    expect(result.ok).toBe(true);
    expect(result.usedBackend).toBe('first');
    expect(spoken).toEqual(['测试']);
  });

  it('后端失败时沿链降级', async () => {
    const chain = new TtsChain([fakeBackend('bad', { fail: true }), fakeBackend('good')]);
    const result = await chain.speak({ text: '测试' });
    expect(result.ok).toBe(true);
    expect(result.usedBackend).toBe('good');
    expect(result.errors).toHaveLength(1);
  });

  it('不可用的后端被跳过', async () => {
    const chain = new TtsChain([fakeBackend('unavailable', { available: false })]);
    const result = await chain.speak({ text: '测试' });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('当前环境不可用');
  });

  it('全部失败时 ok 为 false 并收集错误', async () => {
    const chain = new TtsChain([
      fakeBackend('a', { fail: true }),
      fakeBackend('b', { fail: true }),
    ]);
    const result = await chain.speak({ text: '测试' });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('新播报等待被取消的旧播报退出，旧播报不能报告成功', async () => {
    const started: string[] = [];
    let release = (): void => undefined;
    let oldSignal: AbortSignal | undefined;
    const chain = new TtsChain([
      {
        name: 'blocking',
        isAvailable: () => true,
        speak(options, signal) {
          started.push(options.text);
          if (options.text === 'first') {
            oldSignal = signal;
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return Promise.resolve();
        },
      },
    ]);
    const first = chain.speak({ text: 'first' });
    const second = chain.speak({ text: 'second' });
    await Promise.resolve();
    expect(oldSignal?.aborted).toBe(true);
    expect(started).toEqual(['first']);
    release();
    expect((await first).ok).toBe(false);
    expect(await second).toMatchObject({ ok: true, usedBackend: 'blocking' });
    expect(started).toEqual(['first', 'second']);
  });

  it('可用性探测异常转为失败结果，不泄漏未处理的Promise', async () => {
    const chain = new TtsChain([
      {
        name: 'bad-probe',
        isAvailable() {
          throw new Error('探测失败');
        },
        speak: async () => undefined,
      },
    ]);
    expect(await chain.speak({ text: 'test' })).toEqual({ ok: false, errors: ['探测失败'] });
    expect((await chain.speak({ text: 'retry' })).ok).toBe(false);
  });
});

describe('announce', () => {
  it('规则为 mute 时不调用 TTS', async () => {
    const spoken: string[] = [];
    const chain = new TtsChain([fakeBackend('native', { spoken })]);
    const result = await announce(
      { toolId: 'demo-tool', eventType: 'task.completed', sessionId: 'demo-tool:p:s' },
      [
        {
          ruleId: 'r1',
          scopeTool: null,
          scopeEvent: '*',
          action: 'mute',
        },
      ],
      chain,
    );
    expect(result.action).toBe('mute');
    expect(spoken).toHaveLength(0);
  });

  it('规则为 speak 时播报渲染后的文本', async () => {
    const spoken: string[] = [];
    const chain = new TtsChain([fakeBackend('native', { spoken })]);
    const result = await announce(
      {
        toolId: 'demo-tool',
        eventType: 'task.waiting_human',
        sessionId: 'demo-tool:p:s',
        title: '重构登录模块',
      },
      [
        {
          ruleId: 'r2',
          scopeTool: null,
          scopeEvent: 'task.waiting_human',
          action: 'speak',
          template: '{tool} 等你拍板',
        },
      ],
      chain,
    );
    expect(result.action).toBe('speak');
    expect(spoken).toEqual(['demo-tool 等你拍板']);
    expect(result.speak?.ok).toBe(true);
  });
});
