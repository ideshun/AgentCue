/**
 * 事件总线单测。
 * 覆盖：同会话串行有序、不同会话互不阻塞、idle 等待排空。
 */
import { describe, expect, it } from 'vitest';
import { createStandardEvent } from '../normalize/normalize';
import { SessionEventBus } from './event-bus';

/** 构造事件 */
function event(sessionId: string, seq: number) {
  return createStandardEvent({
    sessionId,
    toolId: 'demo-tool',
    eventType: 'task.started',
    occurredAt: `2026-10-19T10:00:0${seq}.000Z`,
    payload: { heartbeatSeq: seq },
  });
}

describe('SessionEventBus', () => {
  it('同会话事件按入队顺序串行处理', async () => {
    const handled: number[] = [];
    const bus = new SessionEventBus((e) => {
      handled.push(Number(e.payload.heartbeatSeq));
    });

    bus.enqueue(event('demo:proj:a', 1));
    bus.enqueue(event('demo:proj:a', 2));
    bus.enqueue(event('demo:proj:a', 3));
    await bus.idle();

    expect(handled).toEqual([1, 2, 3]);
  });

  it('异步处理器同样保证同会话串行', async () => {
    const handled: string[] = [];
    const bus = new SessionEventBus(async (e) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      handled.push(e.sessionId);
    });

    bus.enqueue(event('demo:proj:b', 1));
    bus.enqueue(event('demo:proj:b', 2));
    await bus.idle();

    expect(handled).toEqual(['demo:proj:b', 'demo:proj:b']);
  });

  it('不同会话互不阻塞，事件都会得到处理', async () => {
    const handled: string[] = [];
    const bus = new SessionEventBus((e) => {
      handled.push(e.sessionId);
    });

    bus.enqueue(event('demo:proj:first', 1));
    bus.enqueue(event('demo:proj:second', 1));
    bus.enqueue(event('demo:proj:first', 2));
    await bus.idle();

    expect(handled).toHaveLength(3);
    expect(handled.filter((id) => id === 'demo:proj:first')).toHaveLength(2);
    expect(handled.filter((id) => id === 'demo:proj:second')).toHaveLength(1);
  });

  it('pending 反映未处理条数', async () => {
    const bus = new SessionEventBus(() => {
      // 空处理器，仅验证计数
    });
    bus.enqueue(event('demo:proj:c', 1));
    await bus.idle();
    expect(bus.pending('demo:proj:c')).toBe(0);
  });

  it('未处理队列按 occurredAt 补正，不按入队顺序', async () => {
    const handled: number[] = [];
    const bus = new SessionEventBus((e) => {
      handled.push(Number(e.payload.heartbeatSeq));
    });
    bus.enqueue(event('demo:proj:d', 3));
    bus.enqueue(event('demo:proj:d', 1));
    bus.enqueue(event('demo:proj:d', 2));
    await bus.idle();
    expect(handled).toEqual([1, 2, 3]);
  });

  it('已处理更晚事件后再到的过期事件记为 anomaly', async () => {
    const handled: Array<{ seq: number; type: string }> = [];
    const bus = new SessionEventBus(async (e) => {
      handled.push({ seq: Number(e.payload.heartbeatSeq), type: e.eventType });
      await Promise.resolve();
    });
    bus.enqueue(event('demo:proj:e', 2));
    await bus.idle();
    bus.enqueue(event('demo:proj:e', 1));
    await bus.idle();
    expect(handled).toEqual([
      { seq: 2, type: 'task.started' },
      { seq: 1, type: 'anomaly' },
    ]);
  });
});
