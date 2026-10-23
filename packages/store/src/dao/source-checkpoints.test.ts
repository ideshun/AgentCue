import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceCheckpoint } from '@awm/schema';
import { applyMigrations, createDatabase } from '../db';
import { MIGRATIONS } from '../migrations';
import { schema } from '../schema';
import { getSourceCheckpoint, saveSourceCheckpoint } from './source-checkpoints';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const checkpoint: SourceCheckpoint = {
  sourcePath: '/tmp/synthetic/session.jsonl', toolId: 'demo-tool', fileIdentity: '1:2:3',
  offset: 123, prefixHash: 'synthetic-prefix', title: '文件级用户标题', updatedAt: '2026-10-21T00:00:00.000Z',
};

describe('来源任务上下文检查点', () => {
  it('完整上下文 JSON 往返与位置、文件标题一同保存', () => {
    const handle = createDatabase(':memory:');
    databases.push(handle.sqlite);
    const value: SourceCheckpoint = {
      ...checkpoint,
      context: { taskId: 'turn-one', title: '当前轮标题', closed: true, pendingTitle: '下一轮标题', excluded: true },
    };
    saveSourceCheckpoint(handle.db, value);
    expect(getSourceCheckpoint(handle.db, value.sourcePath)).toEqual(value);
    const updated = { ...value, offset: 456, context: { taskId: 'turn-two', title: null, closed: false } };
    saveSourceCheckpoint(handle.db, updated);
    expect(getSourceCheckpoint(handle.db, value.sourcePath)).toEqual(updated);
    const raw = handle.sqlite.prepare('SELECT context FROM source_checkpoints').get() as { context: string };
    expect(JSON.parse(raw.context)).toEqual(updated.context);
  });

  it.each([undefined, null])('兼容未提供或为空的上下文 %s', (context) => {
    const handle = createDatabase(':memory:');
    databases.push(handle.sqlite);
    saveSourceCheckpoint(handle.db, { ...checkpoint, context });
    expect(getSourceCheckpoint(handle.db, checkpoint.sourcePath)).toEqual({ ...checkpoint, context: null });
  });

  it.each(['{bad json', '[]', '{"taskId":42}', '{"closed":"true"}'])('损坏上下文 %s 不破坏已提交位置', (context) => {
    const handle = createDatabase(':memory:');
    databases.push(handle.sqlite);
    saveSourceCheckpoint(handle.db, checkpoint);
    handle.sqlite.prepare('UPDATE source_checkpoints SET context = ?').run(context);
    expect(getSourceCheckpoint(handle.db, checkpoint.sourcePath)).toEqual({ ...checkpoint, context: null });
  });

  it('v3 迁移只增可空 context 列，保留旧位置，重复迁移幂等', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    for (const migration of MIGRATIONS.filter((item) => item.version <= 3)) sqlite.exec(migration.sql);
    sqlite.pragma('user_version = 3');
    sqlite.prepare('INSERT INTO source_checkpoints (source_path,tool_id,file_identity,byte_offset,prefix_hash,title,updated_at) VALUES (?,?,?,?,?,?,?)').run(
      checkpoint.sourcePath, checkpoint.toolId, checkpoint.fileIdentity, checkpoint.offset,
      checkpoint.prefixHash, checkpoint.title, checkpoint.updatedAt,
    );
    applyMigrations(sqlite);
    expect(sqlite.pragma('user_version', { simple: true })).toBe(5);
    const db = drizzle(sqlite, { schema });
    expect(getSourceCheckpoint(db, checkpoint.sourcePath)).toEqual({ ...checkpoint, context: null });
    applyMigrations(sqlite);
    expect(getSourceCheckpoint(db, checkpoint.sourcePath)).toEqual({ ...checkpoint, context: null });
  });
});
