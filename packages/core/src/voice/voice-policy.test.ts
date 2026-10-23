/**
 * 播报策略单测：去抖合并、免打扰时段、优先级队列。
 */
import { describe, expect, it } from 'vitest';
import { DebounceMerger } from './debouncer';
import { inRange, isQuiet, toMinutes } from './quiet-hours';
import { PriorityQueue, canInterrupt, priorityForEvent } from './queue';

/** 构造候选 */
function candidate(at: number, overrides: Partial<{ sessionId: string; toolId: string }> = {}) {
  return {
    sessionId: overrides.sessionId ?? 'demo:p:s1',
    toolId: overrides.toolId ?? 'demo-tool',
    eventType: 'task.completed' as const,
    at,
  };
}

describe('DebounceMerger', () => {
  it('同一稳定事件只接受一次，不随30秒窗口过期或被后续事件替换', () => {
    const merger = new DebounceMerger();
    const original = { ...candidate(10_000), eventId: 'evt_original' };
    expect(merger.decide(original).emit).toBe(true);
    expect(merger.decide({ ...original, at: 45_000 }).reason).toBe('dedupe');
    expect(merger.decide({ ...original, eventId: 'evt_new', at: 45_000 }).emit).toBe(true);
    expect(merger.decide({ ...original, at: 24 * 60 * 60_000 }).reason).toBe('dedupe');
  });

  it('冷却拒绝的事件尚未被消费，延后仍可接受一次', () => {
    const merger = new DebounceMerger();
    merger.decide(candidate(10_000));
    const next = { ...candidate(11_000, { sessionId: 'new' }), eventId: 'evt_delayed' };
    expect(merger.decide(next).reason).toBe('cooldown');
    expect(merger.decide({ ...next, at: 13_000 }).emit).toBe(true);
    expect(merger.decide({ ...next, at: 50_000 }).reason).toBe('dedupe');
  });

  it('同状态窗口拒绝的新事件不被提前标记为已消费', () => {
    const merger = new DebounceMerger();
    merger.decide({ ...candidate(10_000), eventId: 'evt_first' });
    const next = { ...candidate(20_000), eventId: 'evt_next' };
    expect(merger.decide(next).reason).toBe('dedupe');
    expect(merger.decide({ ...next, at: 45_000 }).emit).toBe(true);
    expect(merger.decide({ ...next, at: 80_000 }).reason).toBe('dedupe');
  });

  it('首次候选允许播报', () => {
    const merger = new DebounceMerger();
    expect(merger.decide(candidate(10_000)).emit).toBe(true);
  });

  it('全局 2s 冷却内的候选被抑制', () => {
    const merger = new DebounceMerger();
    merger.decide(candidate(10_000));
    expect(merger.decide(candidate(11_000, { sessionId: 'new' }))).toMatchObject({
      reason: 'cooldown',
      retryAfterMs: 1000,
    });
  });

  it('延后接受的新任务记录去重，重复项不因绕过冷却再入队', () => {
    const merger = new DebounceMerger();
    expect(merger.decide(candidate(0)).emit).toBe(true);
    const next = candidate(1000, { sessionId: 'new' });
    expect(merger.decide(next).reason).toBe('cooldown');
    expect(merger.decide(next, { bypassCooldown: true }).emit).toBe(true);
    expect(merger.decide(next, { bypassCooldown: true }).reason).toBe('dedupe');
  });

  it('同会话同类 30s 内去重', () => {
    const merger = new DebounceMerger();
    merger.decide(candidate(10_000));
    expect(merger.decide(candidate(20_000)).reason).toBe('dedupe');
    expect(merger.decide(candidate(45_000)).emit).toBe(true);
  });

  it('不同会话互不受去重影响（受全局冷却约束）', () => {
    const merger = new DebounceMerger();
    merger.decide(candidate(10_000, { sessionId: 'a' }));
    expect(merger.decide(candidate(13_000, { sessionId: 'b' })).emit).toBe(true);
  });

  it('同工具 5 分钟内第 3 个同类事件触发合并', () => {
    const merger = new DebounceMerger();
    merger.decide(candidate(10_000, { sessionId: 's1' }));
    merger.decide(candidate(40_000, { sessionId: 's2' }));
    const third = merger.decide(candidate(70_000, { sessionId: 's3' }));
    expect(third.emit).toBe(true);
    expect(third.reason).toBe('merged');
    expect(third.mergedCount).toBe(3);
  });
});

describe('toMinutes', () => {
  it('转换合法 HH:mm', () => {
    expect(toMinutes('22:30')).toBe(22 * 60 + 30);
  });

  it('非法格式返回 null', () => {
    expect(toMinutes('25:00')).toBeNull();
    expect(toMinutes('abc')).toBeNull();
  });
});

describe('inRange', () => {
  it('同时段内命中', () => {
    expect(inRange(23 * 60, { from: '22:30', to: '23:30' })).toBe(true);
  });

  it('跨天时段的夜侧命中', () => {
    expect(inRange(23 * 60, { from: '22:30', to: '08:30' })).toBe(true);
  });

  it('跨天时段的晨侧命中', () => {
    expect(inRange(7 * 60, { from: '22:30', to: '08:30' })).toBe(true);
  });

  it('跨天时段外不命中', () => {
    expect(inRange(12 * 60, { from: '22:30', to: '08:30' })).toBe(false);
  });
});

describe('isQuiet', () => {
  const base = {
    globalMute: false,
    ranges: [{ from: '22:30', to: '08:30' }],
    waitingHumanOverride: true,
  };

  it('全局静音时免打扰', () => {
    expect(
      isQuiet({
        ...base,
        globalMute: true,
        eventType: 'task.completed',
        now: new Date(2026, 9, 20, 12, 0),
      }),
    ).toBe(true);
  });

  it('waiting_human 在免打扰时段内仍可出声', () => {
    expect(
      isQuiet({ ...base, eventType: 'task.waiting_human', now: new Date(2026, 9, 20, 23, 0) }),
    ).toBe(false);
  });

  it('waiting_human 例外不能突破全局静音', () => {
    expect(
      isQuiet({
        ...base,
        globalMute: true,
        eventType: 'task.waiting_human',
        now: new Date(2026, 9, 20, 23, 0),
      }),
    ).toBe(true);
  });

  it('普通事件在免打扰时段内静音', () => {
    expect(
      isQuiet({ ...base, eventType: 'task.completed', now: new Date(2026, 9, 20, 23, 0) }),
    ).toBe(true);
  });

  it('白天不静音', () => {
    expect(
      isQuiet({ ...base, eventType: 'task.completed', now: new Date(2026, 9, 20, 14, 0) }),
    ).toBe(false);
  });
});

describe('priorityForEvent', () => {
  it('待介入与失败为高优', () => {
    expect(priorityForEvent('task.waiting_human')).toBe('high');
    expect(priorityForEvent('task.failed')).toBe('high');
  });

  it('完成为低优', () => {
    expect(priorityForEvent('task.completed')).toBe('low');
  });

  it('其余为中优', () => {
    expect(priorityForEvent('task.started')).toBe('mid');
  });
});

describe('canInterrupt', () => {
  it('无当前播报时可打断', () => {
    expect(canInterrupt(undefined, 'low')).toBe(true);
  });

  it('高优可打断低优', () => {
    expect(canInterrupt('low', 'high')).toBe(true);
  });

  it('低优不可打断高优', () => {
    expect(canInterrupt('high', 'low')).toBe(false);
  });

  it('同级不可打断', () => {
    expect(canInterrupt('mid', 'mid')).toBe(false);
  });
});

describe('PriorityQueue', () => {
  it('按优先级出队', () => {
    const queue = new PriorityQueue<{ id: string; priority: 'low' | 'mid' | 'high' }>();
    queue.enqueue({ id: 'low', priority: 'low' });
    queue.enqueue({ id: 'high', priority: 'high' });
    queue.enqueue({ id: 'mid', priority: 'mid' });
    expect(queue.dequeue()?.id).toBe('high');
    expect(queue.dequeue()?.id).toBe('mid');
    expect(queue.dequeue()?.id).toBe('low');
    expect(queue.size).toBe(0);
  });

  it('同级先进先出', () => {
    const queue = new PriorityQueue<{ id: string; priority: 'low' | 'mid' | 'high' }>();
    queue.enqueue({ id: 'first', priority: 'mid' });
    queue.enqueue({ id: 'second', priority: 'mid' });
    expect(queue.dequeue()?.id).toBe('first');
  });

  it('空队列返回 undefined', () => {
    const queue = new PriorityQueue<{ id: string; priority: 'low' }>();
    expect(queue.dequeue()).toBeUndefined();
  });
});
