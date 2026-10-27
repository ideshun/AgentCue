/**
 * 存储层集成测试（内存库）。
 * 覆盖：建库迁移、工具 upsert、迁移落库事务、时间线查询。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { StandardEvent } from '@awm/schema';
import { createDatabase, type AppDb } from '../db';
import { upsertTool, listTools } from './tools';
import {
  countActiveByTool,
  countByState,
  ensureSessionRow,
  getSession,
  listSessions,
  updateSessionTitle,
} from './sessions';
import { listTimeline } from './events';
import { persistTransition } from './transition';
import { appendNotification, listNotifications, markNotificationRead } from './notifications';
import { listMcpServers, upsertMcpServer } from './mcp-servers';

/** 构造标准事件 */
function makeEvent(overrides: Partial<StandardEvent> = {}): StandardEvent {
  return {
    eventId: 'evt_test_0001',
    sessionId: 'demo-tool:proj:sess-1',
    toolId: 'demo-tool',
    eventType: 'task.started',
    occurredAt: '2026-10-19T10:00:00.000Z',
    actor: 'tool',
    payload: { taskTitle: '重构登录模块' },
    schemaVersion: 1,
    ...overrides,
  };
}

describe('store', () => {
  let db: AppDb;

  beforeEach(() => {
    const handle = createDatabase(':memory:');
    db = handle.db;
    upsertTool(db, {
      toolId: 'demo-tool',
      name: 'Demo Tool',
      adapterId: 'demo-tool',
      detectStatus: 'running',
    });
  });

  it('建库后表结构可用', () => {
    expect(listTools(db)).toHaveLength(1);
    expect(listTools(db)[0]?.detectStatus).toBe('running');
  });

  it('工具 upsert 不覆盖 first_seen_at', () => {
    const before = listTools(db)[0];
    upsertTool(db, {
      toolId: 'demo-tool',
      name: 'Demo Tool',
      adapterId: 'demo-tool',
      detectStatus: 'installed',
    });
    const after = listTools(db)[0];
    expect(after?.firstSeenAt).toBe(before?.firstSeenAt);
    expect(after?.detectStatus).toBe('installed');
  });

  it('迁移落库同时更新会话当前态与事件日志', () => {
    persistTransition(db, {
      event: makeEvent(),
      prevState: null,
      nextState: 'running',
    });

    const session = getSession(db, 'demo-tool:proj:sess-1');
    expect(session?.currentState).toBe('running');
    expect(session?.title).toBe('重构登录模块');
    expect(listTimeline(db, 'demo-tool:proj:sess-1')).toHaveLength(1);
  });

  it('后续迁移追加事件并刷新状态', () => {
    persistTransition(db, { event: makeEvent(), prevState: null, nextState: 'running' });
    persistTransition(db, {
      event: makeEvent({
        eventId: 'evt_test_0002',
        eventType: 'task.waiting_human',
        occurredAt: '2026-10-19T10:01:00.000Z',
        payload: { taskTitle: '重构登录模块', reason: 'tool_approval' },
      }),
      prevState: 'running',
      nextState: 'waiting_human',
    });

    expect(getSession(db, 'demo-tool:proj:sess-1')?.currentState).toBe('waiting_human');
    expect(listTimeline(db, 'demo-tool:proj:sess-1')).toHaveLength(2);
    expect(listSessions(db, { state: 'waiting_human' })).toHaveLength(1);
  });

  it.each([
    ['human.responded', undefined],
    ['human.responded', ''],
    ['human.responded', '  '],
    ['heartbeat.lost', undefined],
    ['heartbeat.lost', ''],
    ['heartbeat.lost', '  '],
  ] as const)('%s 不用缺失或空白标题 %s 清空会话标题', (eventType, taskTitle) => {
    const startingState = eventType === 'human.responded' ? 'waiting_human' : 'running';
    const nextState = eventType === 'human.responded' ? 'running' : 'timeout';
    persistTransition(db, { event: makeEvent(), prevState: null, nextState: startingState });
    persistTransition(db, {
      event: makeEvent({
        eventId: 'evt_no_title',
        eventType,
        actor: eventType === 'human.responded' ? 'mcp' : 'system',
        occurredAt: '2026-10-19T10:01:00.000Z',
        payload: { reason: 'synthetic metadata regression', taskTitle },
      }),
      prevState: startingState,
      nextState,
    });
    expect(getSession(db, 'demo-tool:proj:sess-1')).toMatchObject({
      title: '重构登录模块',
      currentState: nextState,
      updatedAt: '2026-10-19T10:01:00.000Z',
    });
    expect(listTimeline(db, 'demo-tool:proj:sess-1')).toHaveLength(2);
  });

  it('迁移中可用的新标题仍覆盖旧标题', () => {
    persistTransition(db, { event: makeEvent(), prevState: null, nextState: 'running' });
    persistTransition(db, {
      event: makeEvent({
        eventId: 'evt_new_title',
        eventType: 'task.completed',
        payload: { taskTitle: '补全新的任务标题' },
      }),
      prevState: 'running',
      nextState: 'completed',
    });
    expect(getSession(db, 'demo-tool:proj:sess-1')?.title).toBe('补全新的任务标题');
  });

  it('标题元数据更新和清空仅改变标题，不改变状态、时间或时间线', () => {
    const sessionId = 'demo-tool:proj:sess-1';
    persistTransition(db, {
      event: makeEvent(),
      prevState: null,
      nextState: 'completed',
      endedAt: '2026-10-19T10:05:00.000Z',
    });
    const before = getSession(db, sessionId)!;
    const timeline = listTimeline(db, sessionId);
    expect(updateSessionTitle(db, sessionId, '从用户输入修复的标题')).toBe(true);
    expect(getSession(db, sessionId)).toEqual({ ...before, title: '从用户输入修复的标题' });
    expect(updateSessionTitle(db, sessionId, '从用户输入修复的标题')).toBe(false);
    expect(updateSessionTitle(db, sessionId, null)).toBe(true);
    expect(getSession(db, sessionId)).toEqual({ ...before, title: null });
    expect(updateSessionTitle(db, sessionId, null)).toBe(false);
    expect(updateSessionTitle(db, 'missing-session', '不能创建会话')).toBe(false);
    expect(getSession(db, 'missing-session')).toBeUndefined();
    expect(listTimeline(db, sessionId)).toEqual(timeline);
  });

  it('终态迁移可写入 endedAt', () => {
    persistTransition(db, { event: makeEvent(), prevState: null, nextState: 'running' });
    persistTransition(db, {
      event: makeEvent({
        eventId: 'evt_test_0003',
        eventType: 'task.completed',
        occurredAt: '2026-10-19T10:05:00.000Z',
      }),
      prevState: 'running',
      nextState: 'completed',
      endedAt: '2026-10-19T10:05:00.000Z',
    });

    const session = getSession(db, 'demo-tool:proj:sess-1');
    expect(session?.currentState).toBe('completed');
    expect(session?.endedAt).toBe('2026-10-19T10:05:00.000Z');
  });

  it('ensureSessionRow 懒创建不覆盖已有会话', () => {
    persistTransition(db, { event: makeEvent(), prevState: null, nextState: 'running' });
    // 已存在的行：懒创建不得改写状态与标题
    ensureSessionRow(db, {
      sessionId: 'demo-tool:proj:sess-1',
      toolId: 'demo-tool',
      state: 'idle',
      ts: '2026-10-19T11:00:00.000Z',
    });
    expect(getSession(db, 'demo-tool:proj:sess-1')?.currentState).toBe('running');

    // 不存在的会话：创建为 idle，供 anomaly / tool.detected 落库使用
    ensureSessionRow(db, {
      sessionId: 'demo-tool:proj-a:orphan',
      toolId: 'demo-tool',
      state: 'idle',
      ts: '2026-10-19T11:00:00.000Z',
    });
    const orphan = getSession(db, 'demo-tool:proj-a:orphan');
    expect(orphan?.currentState).toBe('idle');
    expect(orphan?.title).toBeNull();
  });

  it('聚合统计按 SQL 分组返回', () => {
    persistTransition(db, { event: makeEvent(), prevState: null, nextState: 'running' });
    persistTransition(db, {
      event: makeEvent({
        eventId: 'evt_test_0004',
        sessionId: 'demo-tool:proj:sess-2',
        eventType: 'task.started',
      }),
      prevState: null,
      nextState: 'running',
    });
    persistTransition(db, {
      event: makeEvent({
        eventId: 'evt_test_0005',
        sessionId: 'demo-tool:proj:sess-2',
        eventType: 'task.completed',
        occurredAt: '2026-10-19T10:06:00.000Z',
      }),
      prevState: 'running',
      nextState: 'completed',
    });

    const byState = countByState(db);
    expect(byState.get('running')).toBe(1);
    expect(byState.get('completed')).toBe(1);

    // 已完成任务不计入活跃数；此处只有 sess-1 仍在运行。
    const byTool = countActiveByTool(db);
    expect(byTool.get('demo-tool')).toBe(1);
  });
});

describe('notifications 与 mcp_servers', () => {
  it('写入并列出通知', () => {
    const handle = createDatabase(':memory:');
    appendNotification(handle.db, { title: 't', body: 'b', level: 'info' });
    expect(listNotifications(handle.db)).toHaveLength(1);
    markNotificationRead(handle.db);
    expect(listNotifications(handle.db)[0]?.read).toBe(1);
  });

  it('offset 翻页不重不漏（同秒时间戳按 id 决定次序）', () => {
    const handle = createDatabase(':memory:');
    for (let index = 0; index < 7; index += 1)
      appendNotification(handle.db, { title: `t${index}`, body: 'b', level: 'info' });
    const first = listNotifications(handle.db, 3, 0).map((row) => row.title);
    const second = listNotifications(handle.db, 3, 3).map((row) => row.title);
    const third = listNotifications(handle.db, 3, 6).map((row) => row.title);
    expect([...first, ...second, ...third]).toHaveLength(7);
    expect(new Set([...first, ...second, ...third]).size).toBe(7);
  });

  it('写入外部 MCP Server', () => {
    const handle = createDatabase(':memory:');
    upsertMcpServer(handle.db, { name: 'demo', transport: 'stdio', command: 'echo' });
    expect(listMcpServers(handle.db)).toHaveLength(1);
  });
});
