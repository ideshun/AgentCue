/**
 * audit_log 表 DAO（FR-20 / C-07）。
 * 注意：审计只记录动作与结果，不记录会话文件内容。
 */
import { desc } from 'drizzle-orm';
import type { AppDb } from '../db';
import { auditLog } from '../schema';

/** audit_log 行类型 */
export type AuditRow = typeof auditLog.$inferSelect;

/** 写入审计的入参 */
export interface AppendAuditInput {
  /** 时间 */
  ts: string;
  /** 发起方 */
  actor: string;
  /** 动作名 */
  action: string;
  /** 目标标识 */
  target?: string | null;
  /** 结果描述 */
  result?: string | null;
}

/**
 * 追加一条审计记录。
 * @param db 数据库句柄
 * @param input 审计内容
 */
export function appendAudit(db: AppDb, input: AppendAuditInput): void {
  db.insert(auditLog)
    .values({
      ts: input.ts,
      actor: input.actor,
      action: input.action,
      target: input.target ?? null,
      result: input.result ?? null,
    })
    .run();
}

/**
 * 查询最近的审计记录。
 * @param db 数据库句柄
 * @param limit 条数
 * @returns 审计行列表，按时间倒序
 */
export function listAudit(db: AppDb, limit = 100): AuditRow[] {
  return db.select().from(auditLog).orderBy(desc(auditLog.ts)).limit(limit).all();
}
