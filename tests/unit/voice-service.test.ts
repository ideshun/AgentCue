/** 自动提醒与试听的生命周期测试；只使用假规则和假播放后端。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@awm/schema';
import type { AppDb } from '@awm/store';
import { TtsChain, type TtsBackend, type VoiceRule } from '@awm/core';
import { VoiceService, type VoiceNotice } from '../../apps/desktop/src/main/voice-service';

const stored = vi.hoisted(() => ({ rules: [] as unknown[] }));
vi.mock('@awm/store', () => ({ listVoiceRules: () => stored.rules }));

const noon = new Date(2026, 0, 1, 12, 0);
const signal = (id = 'one') => ({
  toolId: 'demo',
  sessionId: 'demo:p:' + id,
  eventType: 'task.completed' as const,
  title: '任务',
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function fixture(backend?: TtsBackend) {
  const settings = defaultSettings();
  settings.quiet.ranges = [];
  // 既有用例针对开始/完成/待确认三类播报；默认范围只看待确认，这里显式放宽。
  settings.voice.scope = 'all';
  const notices: VoiceNotice[] = [];
  const played: string[] = [];
  let chain = new TtsChain([
    backend ?? {
      name: 'fake',
      isAvailable: () => true,
      speak: async ({ text }) => {
        played.push(text);
      },
    },
  ]);
  const service = new VoiceService({
    db: {} as AppDb,
    getSettings: () => settings,
    getChain: () => chain,
    onNotify: (notice) => notices.push(notice),
  });
  return {
    service,
    settings,
    notices,
    played,
    replace: (next: TtsChain) => {
      chain = next;
    },
  };
}

beforeEach(() => {
  stored.rules = [];
});
afterEach(() => vi.useRealTimers());

describe('VoiceService', () => {
  it.each([
    'task.failed',
    'task.timeout',
    'task.retried',
    'human.responded',
    'task.archived',
    'task.cancelled',
    'heartbeat.lost',
    'anomaly',
    'tool.detected',
  ] as const)('%s 即使旧规则选择播报也只发通知', async (eventType) => {
    stored.rules = [{ ruleId: 'old-speak', scopeEvent: '*', action: 'speak' } satisfies VoiceRule];
    const f = fixture();
    expect(await f.service.announce({ ...signal(), eventType }, noon)).toMatchObject({
      action: 'notify',
      reason: 'event-notification-only',
    });
    expect(f.played).toHaveLength(0);
    expect(f.notices).toHaveLength(1);
  });

  it('非播报事件的静音规则仍无通知，显式试听仍可播放', async () => {
    stored.rules = [
      { ruleId: 'muted-failure', scopeEvent: 'task.failed', action: 'mute' } satisfies VoiceRule,
    ];
    const f = fixture();
    expect((await f.service.announce({ ...signal(), eventType: 'task.failed' }, noon)).action).toBe(
      'mute',
    );
    expect(f.notices).toHaveLength(0);
    expect(f.played).toHaveLength(0);
    expect((await f.service.speakText('任务失败的显式试听')).ok).toBe(true);
    expect(f.played).toEqual(['任务失败的显式试听']);
  });

  it('已接受的来源事件在播放完成超过30秒后重复投递仍只播一次', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const f = fixture();
    const event = { ...signal(), eventId: 'evt_only_once' };
    expect((await f.service.announce(event, new Date())).action).toBe('speak');
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await f.service.announce(event, new Date())).action).toBe('skipped');
    f.service.reconfigure();
    expect((await f.service.announce(event, new Date())).action).toBe('skipped');
    expect(f.played).toHaveLength(1);
    expect(f.notices).toHaveLength(0);
  });

  it('同一会话的新事件保留30秒状态窗口，窗口后可提醒而不会被提前记为已接受', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const f = fixture();
    await f.service.announce({ ...signal(), eventId: 'evt_first_delivery' }, new Date());
    await vi.advanceTimersByTimeAsync(1000);
    const next = { ...signal(), eventId: 'evt_new_delivery' };
    expect((await f.service.announce(next, new Date())).action).toBe('skipped');
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await f.service.announce(next, new Date())).action).toBe('speak');
    expect(f.played).toHaveLength(2);
  });

  it('正在播放和冷却排队中的相同事件不重复入队或在队列结束后重播', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const started: string[] = [];
    const finish: Array<() => void> = [];
    const f = fixture({
      name: 'controlled',
      isAvailable: () => true,
      speak: ({ text }) =>
        new Promise<void>((resolve) => {
          started.push(text);
          finish.push(resolve);
        }),
    });
    const playing = { ...signal('playing'), eventId: 'evt_playing_once' };
    const pending = f.service.announce(playing, new Date());
    await flush();
    expect(started).toHaveLength(1);
    expect((await f.service.announce(playing, new Date())).action).toBe('skipped');
    await vi.advanceTimersByTimeAsync(100);
    const queued = { ...signal('queued'), eventId: 'evt_queued_once' };
    expect(await f.service.announce(queued, new Date())).toMatchObject({
      action: 'speak',
      reason: 'queued-cooldown',
    });
    expect((await f.service.announce(queued, new Date())).action).toBe('skipped');
    await vi.advanceTimersByTimeAsync(2000);
    expect(started).toHaveLength(1);
    finish[0]();
    await pending;
    await flush();
    expect(started).toHaveLength(2);
    expect((await f.service.announce(queued, new Date())).action).toBe('skipped');
    finish[1]();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toHaveLength(2);
    expect(f.notices).toHaveLength(0);
    f.service.stop();
  });

  it('显式试听相同文本每次点击各播放一次，不受来源事件去重影响', async () => {
    const f = fixture();
    expect((await f.service.speakText('同一句试听')).ok).toBe(true);
    expect((await f.service.speakText('同一句试听')).ok).toBe(true);
    expect(f.played).toEqual(['同一句试听', '同一句试听']);
  });

  it.each(['task.started', 'task.waiting_human', 'task.completed'] as const)(
    '%s 播报区分工具名、标题和事件',
    async (eventType) => {
      const f = fixture();
      await f.service.announce(
        { ...signal(), toolName: '演示工具', title: '登录模块重构', eventType },
        noon,
      );
      expect(f.played).toHaveLength(1);
      expect(f.played[0]).toContain('演示工具');
      expect(f.played[0]).toContain('登录模块重构');
      expect(f.played[0]).toContain(
        eventType === 'task.started'
          ? '开始处理'
          : eventType === 'task.completed'
            ? '完成'
            : '确认',
      );
    },
  );

  it('自定义文案只补缺失的定位信息，不修改持久化规则', async () => {
    const custom = {
      ruleId: 'custom',
      scopeEvent: '*',
      action: 'speak',
      template: '好了。',
    } satisfies VoiceRule;
    stored.rules = [custom];
    const f = fixture();
    await f.service.announce({ ...signal(), toolName: '演示工具', title: '登录模块' }, noon);
    expect(f.played[0]).toContain('演示工具');
    expect(f.played[0]).toContain('登录模块');
    expect(f.played[0]).toContain('好了。');
    expect(custom.template).toBe('好了。');
  });

  it.each([
    ['attention', 'task.completed', 'notify'],
    ['attention', 'task.started', 'notify'],
    ['attention', 'task.waiting_human', 'speak'],
    ['milestones', 'task.started', 'speak'],
    ['milestones', 'task.completed', 'speak'],
    ['milestones', 'task.waiting_human', 'speak'],
    ['all', 'task.completed', 'speak'],
  ] as const)('播报范围 %s 下 %s 的动作是 %s', async (scope, eventType, action) => {
    const f = fixture();
    f.settings.voice.scope = scope;
    const result = await f.service.announce({ ...signal(), eventType }, noon);
    expect(result.action).toBe(action);
    if (action === 'notify') expect(result.reason).toBe('out-of-scope');
    expect(f.played).toHaveLength(action === 'speak' ? 1 : 0);
  });

  it('超出播报范围的事件仍发通知，但不占用去抖窗口', async () => {
    const f = fixture();
    f.settings.voice.scope = 'attention';
    await f.service.announce({ ...signal('build'), eventType: 'task.completed' }, noon);
    expect(f.notices).toHaveLength(1);
    // 同一会话紧接着的待确认必须立即出声，不能被上一条通知去抖掉。
    const waiting = await f.service.announce(
      { ...signal('build'), eventType: 'task.waiting_human' },
      new Date(noon.getTime() + 100),
    );
    expect(waiting.action).toBe('speak');
    expect(f.played).toHaveLength(1);
    // 同会话同类的越界事件在 30 秒内不重复弹通知。
    expect(
      (await f.service.announce(
        { ...signal('build'), eventType: 'task.completed' },
        new Date(noon.getTime() + 200),
      )).action,
    ).toBe('skipped');
    expect(f.notices).toHaveLength(1);
  });

  it('播报内容默认读精简标题，去掉代码与链接并截到第一个句读', async () => {
    const f = fixture();
    await f.service.announce(
      {
        ...signal(),
        toolName: '演示工具',
        eventType: 'task.waiting_human',
        title: '帮我看下 `pnpm build` 为什么失败，顺便把 https://example.com 也打开',
      },
      noon,
    );
    expect(f.played[0]).toContain('帮我看下');
    expect(f.played[0]).not.toContain('pnpm build');
    expect(f.played[0]).not.toContain('http');
  });

  it('播报内容切到标题原文时保留适配器给的前 40 字', async () => {
    const f = fixture();
    f.settings.voice.content = 'prompt';
    const title = '帮我看下 `pnpm build` 为什么失败，顺便把链接也打开';
    await f.service.announce(
      { ...signal(), toolName: '演示工具', eventType: 'task.started', title },
      noon,
    );
    expect(f.played[0]).toContain('pnpm build');
  });

  it('排队后缩小播报范围，完成事件只通知一次而不继续出声', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    let finish = (): void => {};
    const started: string[] = [];
    const f = fixture({
      name: 'controlled',
      isAvailable: () => true,
      speak: ({ text }) =>
        new Promise<void>((resolve) => {
          started.push(text);
          finish = resolve;
        }),
    });
    const playing = f.service.announce(signal('playing'), new Date());
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await f.service.announce(signal('queued'), new Date())).reason).toBe('queued');
    f.settings.voice.scope = 'attention';
    finish();
    await playing;
    await flush();
    expect(started).toHaveLength(1);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toMatchObject({ sessionId: 'demo:p:queued', reason: 'out-of-scope' });
    f.service.stop();
  });

  it('排队后更改内容模式，出声时重新生成当前模式的文案', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const finish: Array<() => void> = [];
    const started: string[] = [];
    const f = fixture({
      name: 'controlled',
      isAvailable: () => true,
      speak: ({ text }) =>
        new Promise<void>((resolve) => {
          started.push(text);
          finish.push(resolve);
        }),
    });
    f.settings.voice.content = 'prompt';
    const playing = f.service.announce(signal('playing'), new Date());
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    await f.service.announce(
      { ...signal('queued'), title: '重构登录模块。顺便处理日志' },
      new Date(),
    );
    f.settings.voice.content = 'title';
    finish[0]();
    await playing;
    await flush();
    expect(started).toHaveLength(2);
    expect(started[1]).toContain('重构登录模块');
    expect(started[1]).not.toContain('顺便处理日志');
    finish[1]();
    await flush();
    f.service.stop();
  });

  it('标题只有代码或为空时回退到简短任务编号', async () => {
    const f = fixture();
    await f.service.announce({ ...signal('code'), title: '```\nnpm i\n```' }, noon);
    expect(f.played[0]).toMatch(/任务 [A-F0-9]{8}/);
  });

  it('缺标题时播报和通知使用可区分的简短任务编号', async () => {
    const f = fixture();
    await f.service.announce({ ...signal('one'), title: null }, noon);
    expect(f.played[0]).toMatch(/任务 [A-F0-9]{8}/);
    expect(f.played[0]).not.toContain('未命名');
    f.settings.voice.enabled = false;
    await f.service.announce({ ...signal('two'), title: null }, new Date(noon.getTime() + 3000));
    expect(f.notices[0].body).toMatch(/^任务 [A-F0-9]{8}$/);
    expect(f.played[0]).not.toContain(f.notices[0].body);
  });

  it('两秒冷却内的新任务延后播报，同任务重复项不重复排队', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const f = fixture();
    await f.service.announce({ ...signal('turn-one'), eventType: 'task.started' }, noon);
    const next = { ...signal('turn-two'), eventType: 'task.started' as const };
    expect(await f.service.announce(next, new Date(noon.getTime() + 100))).toMatchObject({
      action: 'speak',
      reason: 'queued-cooldown',
    });
    expect((await f.service.announce(next, new Date(noon.getTime() + 200))).reason).toBe('dedupe');
    expect(f.played).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.played).toHaveLength(2);
    expect(f.notices).toHaveLength(0);
  });

  it('冷却到期的待确认提醒仍可打断低优先级完成播报', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const played: string[] = [];
    let aborted = false;
    const f = fixture({
      name: 'fake',
      isAvailable: () => true,
      speak: ({ text }, abort) => {
        played.push(text);
        if (played.length > 1) return Promise.resolve();
        return new Promise<void>((resolve) =>
          abort?.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
      },
    });
    const first = f.service.announce(signal('finished'), noon);
    await flush();
    await f.service.announce(
      { ...signal('approval'), eventType: 'task.waiting_human' },
      new Date(noon.getTime() + 100),
    );
    expect(played).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(aborted).toBe(true);
    expect(played).toHaveLength(2);
    expect(played[1]).toContain('确认');
    expect((await first).reason).toBe('interrupted');
    f.service.stop();
  });

  it('免打扰中不同新任务的通知及时保留，仍去掉同任务重复事件', async () => {
    const f = fixture();
    f.settings.quiet.ranges = [{ from: '00:00', to: '23:59' }];
    await f.service.announce(signal('turn-one'), noon);
    await f.service.announce(signal('turn-two'), new Date(noon.getTime() + 100));
    await f.service.announce(signal('turn-two'), new Date(noon.getTime() + 200));
    expect(f.notices).toHaveLength(2);
    expect(f.notices.every((notice) => notice.reason === 'quiet-hours')).toBe(true);
    expect(f.played).toHaveLength(0);
  });

  it('冷却队列在重配时降级通知，停止时取消且无旧计时器重播', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const f = fixture();
    await f.service.announce(signal('one'), noon);
    await f.service.announce(signal('two'), new Date(noon.getTime() + 100));
    f.settings.quiet.globalMute = true;
    f.service.reconfigure();
    expect(f.notices).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.played).toHaveLength(1);
    f.settings.quiet.globalMute = false;
    await f.service.announce(signal('three'), new Date(noon.getTime() + 3000));
    await f.service.announce(signal('four'), new Date(noon.getTime() + 3100));
    f.service.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.played).toHaveLength(2);
    expect(f.notices).toHaveLength(1);
  });

  it('关闭语音后仍发通知，同会话重复事件被去重', async () => {
    const f = fixture();
    f.settings.voice.enabled = false;
    expect((await f.service.announce(signal(), noon)).action).toBe('notify');
    expect((await f.service.announce(signal(), new Date(noon.getTime() + 5000))).action).toBe(
      'skipped',
    );
    expect(f.notices).toHaveLength(1);
    expect(f.played).toHaveLength(0);
  });

  it('规则静音在语音关闭和全局静音下也不产生通知', async () => {
    stored.rules = [{ ruleId: 'mute', scopeEvent: '*', action: 'mute' } satisfies VoiceRule];
    const f = fixture();
    f.settings.voice.enabled = false;
    f.settings.quiet.globalMute = true;
    expect((await f.service.announce(signal(), noon)).action).toBe('mute');
    expect(f.notices).toHaveLength(0);
  });

  it('待审批例外不能突破全局静音', async () => {
    const f = fixture();
    f.settings.quiet.globalMute = true;
    const result = await f.service.announce({ ...signal(), eventType: 'task.waiting_human' }, noon);
    expect(result).toMatchObject({ action: 'notify', reason: 'global-muted' });
    expect(f.notices).toHaveLength(1);
    expect(f.played).toHaveLength(0);
  });

  it('免打扰期间的通知同样经过去抖', async () => {
    const f = fixture();
    f.settings.quiet.ranges = [{ from: '00:00', to: '23:59' }];
    await f.service.announce(signal(), noon);
    await f.service.announce(signal(), new Date(noon.getTime() + 5000));
    expect(f.notices).toHaveLength(1);
  });

  it('重配取消旧链和待播队列，新的试听等待旧进程真正退出', async () => {
    let finishOld = (): void => undefined;
    let aborted = false;
    const f = fixture({
      name: 'old',
      isAvailable: () => true,
      speak: (_options, signal) =>
        new Promise<void>((resolve) => {
          finishOld = resolve;
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    });
    const first = f.service.announce(signal('one'), noon);
    await flush();
    const second = await f.service.announce(signal('two'), new Date(noon.getTime() + 3000));
    expect(second.reason).toBe('queued');
    f.settings.quiet.globalMute = true;
    f.service.reconfigure();
    expect(aborted).toBe(true);
    expect(f.notices).toHaveLength(2);
    const fresh: string[] = [];
    f.replace(
      new TtsChain([
        {
          name: 'new',
          isAvailable: () => true,
          speak: async ({ text }) => {
            fresh.push(text);
          },
        },
      ]),
    );
    const preview = f.service.speakText('试听');
    await flush();
    expect(fresh).toHaveLength(0);
    finishOld();
    expect(await preview).toMatchObject({ ok: true, usedBackend: 'new' });
    expect(fresh).toEqual(['试听']);
    expect((await first).reason).toBe('interrupted');
    expect(f.settings.quiet.globalMute).toBe(true);
  });

  it('显式试听可在语音关闭时播放，且不修改开关', async () => {
    const f = fixture();
    f.settings.voice.enabled = false;
    expect((await f.service.speakText('测试')).ok).toBe(true);
    expect(f.played).toEqual(['测试']);
    expect(f.settings.voice.enabled).toBe(false);
  });

  it('停止后不再产生播报或通知', async () => {
    const f = fixture();
    f.service.stop();
    expect((await f.service.announce(signal(), noon)).reason).toBe('service-stopped');
    expect((await f.service.speakText('测试')).ok).toBe(false);
    expect(f.played).toHaveLength(0);
    expect(f.notices).toHaveLength(0);
  });

  it('后端失败降级为通知并保留诊断结果', async () => {
    const f = fixture({
      name: 'bad',
      isAvailable: () => true,
      speak: () => Promise.reject(new Error('输出失败')),
    });
    const result = await f.service.announce(signal(), noon);
    expect(result).toMatchObject({ action: 'notify', reason: 'tts-failed', speak: { ok: false } });
    expect(result.speak?.errors[0]).toContain('输出失败');
    expect(f.notices).toHaveLength(1);
  });
});
