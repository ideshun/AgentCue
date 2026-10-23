/**
 * 数据库实例创建与迁移执行。
 * 同步 API（better-sqlite3）便于在 Electron 主进程内直接使用，事务简单。
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MIGRATIONS } from './migrations';
import { schema } from './schema';

/** Drizzle 数据库句柄类型 */
export type AppDb = BetterSQLite3Database<typeof schema>;

/** 数据库句柄包：sqlite 原生实例 + drizzle 句柄 */
export interface DatabaseHandle {
  /** better-sqlite3 原生实例，用于 pragma / 备份等底层操作 */
  sqlite: Database.Database;
  /** Drizzle 句柄，DAO 统一使用 */
  db: AppDb;
}

/**
 * 执行幂等迁移：按版本号递增应用，版本号写入 user_version。
 * @param sqlite better-sqlite3 实例
 * @throws 任一迁移失败时回滚该迁移并抛出带上下文的错误
 */
export function applyMigrations(sqlite: Database.Database): void {
  const current = Number(sqlite.pragma('user_version', { simple: true }));
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(migration.sql);
      sqlite.pragma(`user_version = ${migration.version}`);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`数据库迁移 ${migration.name}（v${migration.version}）执行失败：${message}`);
    }
  }
}

/**
 * 创建数据库句柄并执行迁移。
 * @param dbPath SQLite 文件路径，传 `:memory:` 用于测试
 * @returns 数据库句柄包
 */
export function createDatabase(dbPath: string): DatabaseHandle {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
