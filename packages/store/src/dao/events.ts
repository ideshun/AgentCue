/**
 * state_events 表 DAO（只追加，FR-06/10 审计与时间线）。
 */
import { and, desc, eq, gte, lte, max, sql } from 'drizzle-orm';
import type { EventActor, EventType, StandardEvent, TaskState } from '@awm/schema';
import type { AppDb } from '../db';
import { stateEvents } from '../schema';

/** state_events 表行类型 */
export type StateEventRow = typeof stateEvents.$inferSelect;

/** @description: 重复 hook 按原始事件身份返回已归属的任务轮次。 */
export function getEventSessionId(db: AppDb, eventId: string): string | undefined {
  return db
    .select({ sessionId: stateEvents.sessionId })
    .from(stateEvents)
    .where(eq(stateEvents.eventId, eventId))
    .get()?.sessionId;
}

/** @description: 仅返回本机已接收 hook 的时间，不读取客户端存储或原始内容。 */
export function getLastHookEventAt(db: AppDb, toolId: string): string | null {
  return (
    db
      .select({ at: max(stateEvents.ts) })
      .from(stateEvents)
      .where(
        and(
          eq(stateEvents.toolId, toolId),
          sql`${stateEvents.eventId} LIKE 'evt\\_hook\\_%' ESCAPE '\\'`,
        ),
      )
      .get()?.at ?? null
  );
}

/** 写入状态事件的入参 */
export interface AppendStateEventInput {
  eventId: string;
  sessionId: string;
  toolId: string;
  eventType: EventType;
  /** 迁移前状态，首条可为 null */
  prevState: TaskState | null;
  /** 迁移后状态，非迁移类事件可为 null */
  nextState: TaskState | null;
  actor: EventActor;
  reason?: string | null;
  ts: string;
  /** 原始事件载荷，序列化为 JSON 存储 */
  payload?: StandardEvent['payload'] | null;
}

/**
 * 追加一条状态事件（只追加表，不更新）。
 * @param db 数据库句柄
 * @param input 事件内容
 */
export function appendStateEvent(db: AppDb, input: AppendStateEventInput): void {
  db.insert(stateEvents)
    .values({
      eventId: input.eventId,
      sessionId: input.sessionId,
      toolId: input.toolId,
      eventType: input.eventType,
      prevState: input.prevState,
      nextState: input.nextState,
      actor: input.actor,
      reason: input.reason ?? null,
      ts: input.ts,
      payload: input.payload ? JSON.stringify(input.payload) : null,
    })
    .run();
}

/**
 * 查询会话的迁移时间线（倒序返回，调用方按需反转）。
 * @param db 数据库句柄
 * @param sessionId 会话 id
 * @param limit 返回条数
 * @returns 事件行列表
 */
export function listTimeline(db: AppDb, sessionId: string, limit = 50): StateEventRow[] {
  return db
    .select()
    .from(stateEvents)
    .where(eq(stateEvents.sessionId, sessionId))
    .orderBy(desc(stateEvents.ts))
    .limit(limit)
    .all();
}

/** 事件检索过滤条件（FR-10 导出与检索） */
export interface EventFilter {
  eventType?: EventType;
  toolId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * 按条件检索事件。
 * @param db 数据库句柄
 * @param filter 过滤条件
 * @returns 事件行列表，按时间倒序
 */
export function listEvents(db: AppDb, filter: EventFilter = {}): StateEventRow[] {
  const conditions = [];
  if (filter.eventType) {
    conditions.push(eq(stateEvents.eventType, filter.eventType));
  }
  if (filter.toolId) {
    conditions.push(eq(stateEvents.toolId, filter.toolId));
  }
  if (filter.from) {
    conditions.push(gte(stateEvents.ts, filter.from));
  }
  if (filter.to) {
    conditions.push(lte(stateEvents.ts, filter.to));
  }
  return db
    .select()
    .from(stateEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(stateEvents.ts))
    .limit(filter.limit ?? 200)
    .all();
}
