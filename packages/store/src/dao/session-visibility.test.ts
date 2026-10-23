/** 合成内存库验证内部来源隐藏，不读取用户数据库。 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskState } from '@awm/schema';
import { applyMigrations, createDatabase, type AppDb } from '../db';
import { MIGRATIONS } from '../migrations';
import { schema } from '../schema';
import { listTimeline } from './events';
import {
  countActiveByTool,
  countByState,
  countSessions,
  getSession,
  listSessions,
  setSourceSessionsVisibility,
  updateSessionTitle,
} from './sessions';
import { upsertTool } from './tools';
import { persistTransition } from './transition';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

function fixture(): AppDb {
  const handle = createDatabase(':memory:');
  databases.push(handle.sqlite);
  upsertTool(handle.db, {
    toolId: 'demo',
    name: 'Synthetic tool',
    adapterId: 'demo',
    detectStatus: 'installed',
  });
  return handle.db;
}

function seed(db: AppDb, sessionId: string, state: TaskState = 'running'): void {
  persistTransition(db, {
    event: {
      eventId: 'evt_' + sessionId,
      sessionId,
      toolId: 'demo',
      eventType: 'task.started',
      occurredAt: '2026-10-20T10:00:00.000Z',
      actor: 'tool',
      payload: { taskTitle: 'Synthetic task ' + sessionId },
      schemaVersion: 1,
    },
    prevState: null,
    nextState: state,
    endedAt: state === 'completed' ? '2026-10-20T10:05:00.000Z' : null,
  });
}

describe('session source visibility', () => {
  it('hides source tasks from lists and counts while preserving direct metadata and event access', () => {
    const db = fixture();
    const base = 'demo:project:internal';
    seed(db, base);
    seed(db, base + ':turn:one', 'waiting_human');
    seed(db, base + ':turn:two', 'completed');
    seed(db, 'demo:project:public-running');
    seed(db, 'demo:project:public-completed', 'completed');
    const before = getSession(db, base + ':turn:two')!;
    const timeline = listTimeline(db, before.sessionId);
    expect(before.visible).toBe(1);
    expect(setSourceSessionsVisibility(db, base, false)).toBe(true);
    expect(setSourceSessionsVisibility(db, base, false)).toBe(false);
    expect(listSessions(db)).toHaveLength(2);
    expect(countSessions(db)).toBe(2);
    expect(countSessions(db, { state: 'completed' })).toBe(1);
    expect(countSessions(db, { toolId: 'demo', q: 'internal' })).toBe(0);
    expect(listSessions(db, { states: ['waiting_human'], q: 'internal' })).toEqual([]);
    expect(Object.fromEntries(countByState(db))).toEqual({ running: 1, completed: 1 });
    expect(Object.fromEntries(countActiveByTool(db))).toEqual({ demo: 1 });
    expect(getSession(db, before.sessionId)).toEqual({ ...before, visible: 0 });
    expect(updateSessionTitle(db, before.sessionId, 'Repaired hidden metadata')).toBe(true);
    expect(getSession(db, before.sessionId)).toEqual({
      ...before,
      visible: 0,
      title: 'Repaired hidden metadata',
    });
    expect(listTimeline(db, before.sessionId)).toEqual(timeline);
    expect(setSourceSessionsVisibility(db, base, true)).toBe(true);
    expect(setSourceSessionsVisibility(db, base, true)).toBe(false);
    expect(countSessions(db)).toBe(5);
    expect(Object.fromEntries(countByState(db))).toEqual({
      running: 2,
      waiting_human: 1,
      completed: 2,
    });
    expect(Object.fromEntries(countActiveByTool(db))).toEqual({ demo: 3 });
  });

  it('matches exact source identity and turn prefix, escaping LIKE wildcards and respecting case', () => {
    const db = fixture();
    const base = 'demo:project:a%_\\B';
    const target = [base, base + ':turn:t1'];
    const unrelated = [
      base + ':turning:t1',
      base + '-other:turn:t1',
      'demo:project:axy\\B:turn:t1',
      base.toLowerCase() + ':turn:t1',
    ];
    for (const id of [...target, ...unrelated]) seed(db, id);
    const before = new Map(listSessions(db).map((session) => [session.sessionId, session]));
    expect(setSourceSessionsVisibility(db, base, false)).toBe(true);
    for (const id of target) {
      expect(getSession(db, id)).toEqual({ ...before.get(id), visible: 0 });
      expect(listTimeline(db, id)).toHaveLength(1);
    }
    for (const id of unrelated) expect(getSession(db, id)).toEqual(before.get(id));
    expect(listSessions(db)).toHaveLength(unrelated.length);
    expect(setSourceSessionsVisibility(db, 'missing-source', false)).toBe(false);
  });

  it('migrates v4 sessions to visible by default without changing metadata, state, timestamps or events', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    for (const migration of MIGRATIONS.filter((item) => item.version <= 4))
      sqlite.exec(migration.sql);
    sqlite.pragma('user_version = 4');
    sqlite
      .prepare(
        'INSERT INTO tools (tool_id,name,adapter_id,detect_status,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        'demo',
        'Synthetic tool',
        'demo',
        'installed',
        '2026-10-20T10:00:00Z',
        '2026-10-20T10:00:00Z',
      );
    sqlite
      .prepare(
        'INSERT INTO sessions (session_id,tool_id,project,title,current_state,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        'demo:p:legacy',
        'demo',
        'project',
        'Legacy task',
        'completed',
        'start',
        'end',
        'updated',
      );
    sqlite
      .prepare(
        'INSERT INTO state_events (event_id,session_id,tool_id,event_type,actor,ts) VALUES (?,?,?,?,?,?)',
      )
      .run('evt_legacy', 'demo:p:legacy', 'demo', 'task.completed', 'tool', 'updated');
    const before = sqlite.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    const events = sqlite.prepare('SELECT * FROM state_events').all();
    applyMigrations(sqlite);
    expect(sqlite.pragma('user_version', { simple: true })).toBe(5);
    expect(sqlite.prepare('SELECT * FROM sessions').get()).toEqual({ ...before, visible: 1 });
    const db = drizzle(sqlite, { schema });
    expect(getSession(db, 'demo:p:legacy')).toMatchObject({
      visible: 1,
      title: 'Legacy task',
      currentState: 'completed',
      updatedAt: 'updated',
    });
    expect(countSessions(db)).toBe(1);
    applyMigrations(sqlite);
    expect(sqlite.prepare('SELECT * FROM sessions').get()).toEqual({ ...before, visible: 1 });
    expect(sqlite.prepare('SELECT * FROM state_events').all()).toEqual(events);
  });
});
