/**
 * notifications 表 DAO（FR-24 通知中心）。
 */
import { desc, eq } from 'drizzle-orm';
import type { AppDb } from '../db';
import { notifications } from '../schema';

/** 通知行 */
export type NotificationRow = typeof notifications.$inferSelect;

/** 写入通知入参 */
export interface AppendNotificationInput {
  title: string;
  body: string;
  level: 'attention' | 'info';
  sessionId?: string | null;
}

/**
 * 追加一条通知。
 * @param db 数据库句柄
 * @param input 通知内容
 * @returns 写入后的行
 */
export function appendNotification(db: AppDb, input: AppendNotificationInput): NotificationRow {
  const row = {
    notificationId: `ntf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    title: input.title,
    body: input.body,
    level: input.level,
    read: 0,
    sessionId: input.sessionId ?? null,
  };
  db.insert(notifications).values(row).run();
  return row;
}

/**
 * 列出通知，最新在前。
 * @param db 数据库句柄
 * @param limit 条数
 * @returns 通知列表
 */
export function listNotifications(db: AppDb, limit = 100): NotificationRow[] {
  return db.select().from(notifications).orderBy(desc(notifications.ts)).limit(limit).all();
}

/**
 * 标记已读。id 为空则全部已读。
 * @param db 数据库句柄
 * @param notificationId 通知 id
 */
export function markNotificationRead(db: AppDb, notificationId?: string): void {
  if (notificationId) {
    db.update(notifications).set({ read: 1 }).where(eq(notifications.notificationId, notificationId)).run();
    return;
  }
  db.update(notifications).set({ read: 1 }).run();
}
