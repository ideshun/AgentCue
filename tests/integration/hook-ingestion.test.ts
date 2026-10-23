/** 原生 hook 入库仅用临时合成数据库，不启动客户端、扫描或语音。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StandardEvent } from '@awm/schema';
import type { TransitionResult } from '@awm/core';
import {
  createDatabase,
  getEventSessionId,
  getLastHookEventAt,
  getSession,
  hasSourceEvent,
  listEvents,
  listSessions,
  listSourceSessions,
  listTimeline,
  listTools,
  upsertTool,
} from '@awm/store';
import { Engine, type TransitionDelivery } from '../../apps/desktop/src/main/engine-host';

const fixtures: Array<{ root: string; engine: Engine }> = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'awm-hook-ingestion-'));
  const instance = { root, engine: new Engine(root) };
  fixtures.push(instance);
  return instance;
}
function event(
  id: string,
  eventType: StandardEvent['eventType'],
  second: number,
  title?: string,
  sessionId = 'fixture:hooks:conversation',
): StandardEvent {
  return {
    eventId: 'evt_hook_' + id,
    sessionId,
    toolId: 'fixture',
    eventType,
    occurredAt: new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString(),
    actor: 'tool',
    payload: title ? { taskTitle: title } : {},
    schemaVersion: 1,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const instance of fixtures.splice(0)) {
    await instance.engine.stop();
    rmSync(instance.root, { recursive: true, force: true });
  }
});

describe('hook ingestion', () => {
  it('keeps native turn identity, original event ids and existing tool metadata; duplicates stay silent', async () => {
    const f = fixture();
    upsertTool(f.engine.database, {
      toolId: 'fixture',
      name: 'Previous name',
      adapterId: 'fixture',
      detectStatus: 'installed',
      version: '1.2.3',
      configPath: '/synthetic/config',
      executablePath: '/synthetic/binary',
    });
    const start = event(
      'native-start',
      'task.started',
      0,
      '真实用户任务',
      'fixture:hooks:c:turn:g1',
    );
    const onTransition = vi.fn(
      (_result: TransitionResult, observed: StandardEvent, _delivery?: TransitionDelivery) => {
        expect(getSession(f.engine.database, observed.sessionId)?.title).toBe('真实用户任务');
        expect(hasSourceEvent(f.engine.database, observed.eventId)).toBe(true);
      },
    );
    f.engine.onTransition = onTransition;
    expect(await f.engine.consumeHookEvent(start, 'turn', () => true, 'Fixture Hooks')).toEqual({
      accepted: true,
      sessionId: start.sessionId,
    });
    expect(await f.engine.consumeHookEvent(start, 'turn', () => true, 'Fixture Hooks')).toEqual({
      accepted: false,
      sessionId: start.sessionId,
    });
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition.mock.calls[0]?.[2]).toEqual({ announce: true });
    expect(getEventSessionId(f.engine.database, start.eventId)).toBe(start.sessionId);
    expect(listTools(f.engine.database)[0]).toMatchObject({
      name: 'Fixture Hooks',
      version: '1.2.3',
      configPath: '/synthetic/config',
      executablePath: '/synthetic/binary',
    });
    expect(getLastHookEventAt(f.engine.database, 'fixture')).toBe(start.occurredAt);
    expect(getLastHookEventAt(f.engine.database, 'missing')).toBeNull();
    expect(listEvents(f.engine.database)).toHaveLength(1);
  });

  it('splits session-only hooks into separate turns and deduplicates against the original event after restart', async () => {
    const f = fixture();
    const first = event('first-start', 'task.started', 0, '第一轮任务');
    const one = await f.engine.consumeHookEvent(first, 'session', () => true, 'Fixture Hooks');
    expect(one.sessionId).toMatch(/^fixture:hooks:conversation:turn:[a-f0-9]{24}$/);
    const endOne = await f.engine.consumeHookEvent(
      event('first-stop', 'task.completed', 1),
      'session',
      () => true,
      'Fixture Hooks',
    );
    expect(endOne).toEqual({ accepted: true, sessionId: one.sessionId });
    const two = await f.engine.consumeHookEvent(
      event('second-start', 'task.started', 2, '第二轮任务'),
      'session',
      () => true,
      'Fixture Hooks',
    );
    expect(two.sessionId).not.toBe(one.sessionId);
    await f.engine.consumeHookEvent(
      event('second-stop', 'task.completed', 3),
      'session',
      () => true,
      'Fixture Hooks',
    );
    expect(getSession(f.engine.database, one.sessionId)).toMatchObject({
      title: '第一轮任务',
      currentState: 'completed',
    });
    expect(getSession(f.engine.database, two.sessionId)).toMatchObject({
      title: '第二轮任务',
      currentState: 'completed',
    });
    expect(
      listSourceSessions(f.engine.database, first.sessionId, {
        startedAtOrBefore: event('at', 'task.started', 1).occurredAt,
      })[0]?.sessionId,
    ).toBe(one.sessionId);
    await f.engine.stop();
    f.engine = new Engine(f.root);
    const onTransition = vi.fn();
    f.engine.onTransition = onTransition;
    expect(await f.engine.consumeHookEvent(first, 'session', () => true, 'Fixture Hooks')).toEqual({
      accepted: false,
      sessionId: one.sessionId,
    });
    expect(onTransition).not.toHaveBeenCalled();
    expect(listSessions(f.engine.database)).toHaveLength(2);
    expect(listEvents(f.engine.database)).toHaveLength(4);
    const inspection = createDatabase(path.join(f.root, 'awm.db'));
    try {
      expect(
        inspection.sqlite.prepare('SELECT count(*) AS count FROM source_checkpoints').get(),
      ).toEqual({ count: 0 });
    } finally {
      inspection.sqlite.close();
    }
  });

  it.each(['turn', 'session'] as const)(
    'fills a missing start silently before a terminal event (mode=%s)',
    async (mode) => {
      const f = fixture();
      const onTransition = vi.fn();
      f.engine.onTransition = onTransition;
      const stop = event('stop-without-start', 'task.completed', 1, '缺失开始事件的任务');
      const result = await f.engine.consumeHookEvent(stop, mode, () => true, 'Fixture Hooks');
      expect(result.accepted).toBe(true);
      expect(getSession(f.engine.database, result.sessionId)).toMatchObject({
        title: '缺失开始事件的任务',
        currentState: 'completed',
      });
      expect(
        onTransition.mock.calls.map(([result, , delivery]) => [
          result.eventType,
          delivery.announce,
        ]),
      ).toEqual([
        ['task.started', false],
        ['task.completed', true],
      ]);
      expect(getEventSessionId(f.engine.database, stop.eventId)).toBe(result.sessionId);
      expect(await f.engine.consumeHookEvent(stop, mode, () => true, 'Fixture Hooks')).toEqual({
        accepted: false,
        sessionId: result.sessionId,
      });
      expect(onTransition).toHaveBeenCalledTimes(2);
      expect(listEvents(f.engine.database)).toHaveLength(2);
    },
  );

  it.each([0, 1])(
    'associates a delayed session start with its completed synthetic turn without reopening it (start second=%s)',
    async (second) => {
      const f = fixture();
      const stop = event('early-stop', 'task.completed', 1);
      const completed = await f.engine.consumeHookEvent(stop, 'session', () => true, 'Fixture Hooks');
      const before = getSession(f.engine.database, completed.sessionId)!;
      await f.engine.stop();
      f.engine = new Engine(f.root);
      const onTransition = vi.fn();
      f.engine.onTransition = onTransition;
      const lateStart = event('delayed-start', 'task.started', second, '迟到的真实任务标题');
      expect(
        await f.engine.consumeHookEvent(lateStart, 'session', () => true, 'Fixture Hooks'),
      ).toEqual({ accepted: false, sessionId: completed.sessionId });
      expect(getSession(f.engine.database, completed.sessionId)).toMatchObject({
        title: '迟到的真实任务标题',
        currentState: 'completed',
        startedAt: before.startedAt,
        updatedAt: before.updatedAt,
        endedAt: before.endedAt,
      });
      expect(listSessions(f.engine.database)).toHaveLength(1);
      expect(listSessions(f.engine.database, { states: ['running', 'waiting_human'] })).toEqual([]);
      expect(getEventSessionId(f.engine.database, lateStart.eventId)).toBe(completed.sessionId);
      expect(hasSourceEvent(f.engine.database, lateStart.eventId)).toBe(true);
      expect(
        listTimeline(f.engine.database, completed.sessionId).find(
          (entry) => entry.eventId === lateStart.eventId,
        ),
      ).toMatchObject({
        eventType: 'anomaly',
        actor: 'tool',
        ts: lateStart.occurredAt,
        reason: 'out-of-order',
        payload: JSON.stringify({
          reason: 'out-of-order',
          originalEventType: 'task.started',
          taskTitle: '迟到的真实任务标题',
        }),
      });
      expect(
        await f.engine.consumeHookEvent(lateStart, 'session', () => true, 'Fixture Hooks'),
      ).toEqual({ accepted: false, sessionId: completed.sessionId });
      expect(listEvents(f.engine.database)).toHaveLength(3);
      expect(onTransition).not.toHaveBeenCalled();
    },
  );

  it('matches each existing synthetic terminal turn to at most one real start, in earliest-start order', async () => {
    const f = fixture();
    const base = event('base', 'task.started', 0).sessionId;
    // 模拟已存在的两个补建终态；不放宽 session 模式吞掉重复 stop 的边界。
    for (const [id, second] of [
      ['later', 20],
      ['earlier', 10],
    ] as const) {
      await f.engine.consumeHookEvent(
        event('orphan-stop-' + id, 'task.completed', second, undefined, `${base}:turn:${id}`),
        'turn',
        () => true,
        'Fixture Hooks',
      );
    }
    const onTransition = vi.fn();
    f.engine.onTransition = onTransition;
    const one = await f.engine.consumeHookEvent(
      event('late-first', 'task.started', 0, '第一轮'),
      'session',
      () => true,
      'Fixture Hooks',
    );
    const two = await f.engine.consumeHookEvent(
      event('late-second', 'task.started', 1, '第二轮'),
      'session',
      () => true,
      'Fixture Hooks',
    );
    expect(one).toEqual({ accepted: false, sessionId: `${base}:turn:earlier` });
    expect(two).toEqual({ accepted: false, sessionId: `${base}:turn:later` });
    expect(getSession(f.engine.database, one.sessionId)?.title).toBe('第一轮');
    expect(getSession(f.engine.database, two.sessionId)?.title).toBe('第二轮');
    expect(listSessions(f.engine.database)).toHaveLength(2);
    expect(onTransition).not.toHaveBeenCalled();
    const unrelated = await f.engine.consumeHookEvent(
      event('another-past-start', 'task.started', 2, '独立的过去任务'),
      'session',
      () => true,
      'Fixture Hooks',
    );
    expect(unrelated.accepted).toBe(true);
    expect(unrelated.sessionId).not.toBe(one.sessionId);
    expect(unrelated.sessionId).not.toBe(two.sessionId);
    expect(getSession(f.engine.database, unrelated.sessionId)?.currentState).toBe('running');
    expect(onTransition).toHaveBeenCalledTimes(1);
  });

  it('silently closes an unfinished previous source turn when a new prompt starts', async () => {
    const f = fixture();
    const previous = await f.engine.consumeHookEvent(
      event('unfinished', 'task.started', 0, '旧任务'),
      'session',
      () => true,
      'Fixture Hooks',
    );
    const onTransition = vi.fn();
    f.engine.onTransition = onTransition;
    const next = await f.engine.consumeHookEvent(
      event('next', 'task.started', 1, '新任务'),
      'session',
      () => true,
      'Fixture Hooks',
    );
    expect(getSession(f.engine.database, previous.sessionId)).toMatchObject({
      title: '旧任务',
      currentState: 'cancelled',
    });
    expect(getSession(f.engine.database, next.sessionId)).toMatchObject({
      title: '新任务',
      currentState: 'running',
    });
    expect(
      onTransition.mock.calls.map(([result, , delivery]) => [result.eventType, delivery.announce]),
    ).toEqual([
      ['task.cancelled', false],
      ['task.started', true],
    ]);
  });

  it('uses a silent legal resume before a trustworthy terminal hook for a waiting task', async () => {
    const f = fixture();
    await f.engine.consumeHookEvent(
      event('start-waiting', 'task.started', 0, '等待中的任务'),
      'turn',
      () => true,
      'Fixture Hooks',
    );
    await f.engine.consumeHookEvent(
      event('waiting', 'task.waiting_human', 1),
      'turn',
      () => true,
      'Fixture Hooks',
    );
    const onTransition = vi.fn();
    f.engine.onTransition = onTransition;
    await f.engine.consumeHookEvent(
      event('done-waiting', 'task.completed', 2),
      'turn',
      () => true,
      'Fixture Hooks',
    );
    expect(
      onTransition.mock.calls.map(([result, , delivery]) => [result.eventType, delivery.announce]),
    ).toEqual([
      ['human.responded', false],
      ['task.completed', true],
    ]);
    expect(getSession(f.engine.database, event('any', 'task.started', 0).sessionId)).toMatchObject({
      title: '等待中的任务',
      currentState: 'completed',
    });
  });

  it('checks revocation after awaiting the existing event queue, before any mutation', async () => {
    const f = fixture();
    let release!: () => void;
    const bus = (f.engine as unknown as { bus: { idle: () => Promise<void> } }).bus;
    vi.spyOn(bus, 'idle').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let allowed = true;
    const canCommit = vi.fn(() => allowed);
    const pending = f.engine.consumeHookEvent(
      event('revoked', 'task.started', 0),
      'session',
      canCommit,
      'Fixture Hooks',
    );
    expect(canCommit).not.toHaveBeenCalled();
    allowed = false;
    release();
    expect((await pending).accepted).toBe(false);
    expect(listTools(f.engine.database)).toEqual([]);
    expect(listSessions(f.engine.database)).toEqual([]);
    expect(listEvents(f.engine.database)).toEqual([]);
    expect(hasSourceEvent(f.engine.database, 'evt_hook_revoked')).toBe(false);
  });

  it('rolls back tool, metadata, event receipt and actor state on transaction failure, then retries once', async () => {
    const f = fixture();
    const onTransition = vi.fn();
    f.engine.onTransition = onTransition;
    const inspection = createDatabase(path.join(f.root, 'awm.db'));
    const start = event('rollback', 'task.started', 0, '原子提交任务');
    try {
      inspection.sqlite.exec(
        "CREATE TRIGGER reject_hook BEFORE INSERT ON source_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;",
      );
      await expect(
        f.engine.consumeHookEvent(start, 'session', () => true, 'Fixture Hooks'),
      ).rejects.toThrow('synthetic receipt failure');
      expect(listTools(f.engine.database)).toEqual([]);
      expect(listSessions(f.engine.database)).toEqual([]);
      expect(listEvents(f.engine.database)).toEqual([]);
      expect(hasSourceEvent(f.engine.database, start.eventId)).toBe(false);
      expect(onTransition).not.toHaveBeenCalled();
      inspection.sqlite.exec('DROP TRIGGER reject_hook;');
      const result = await f.engine.consumeHookEvent(start, 'session', () => true, 'Fixture Hooks');
      expect(result.accepted).toBe(true);
      expect(f.engine.getState(result.sessionId)).toBe('running');
      expect(getSession(f.engine.database, result.sessionId)?.title).toBe('原子提交任务');
      expect(onTransition).toHaveBeenCalledTimes(1);
    } finally {
      inspection.sqlite.close();
    }
  });
});
