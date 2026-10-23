/**
 * sessions 表 DAO（FR-08/10，会话看板与详情抽屉数据源）。
 */
import { and, count, desc, eq, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { TaskState } from '@awm/schema';
import type { AppDb } from '../db';
import { sessions } from '../schema';

/** sessions 表行类型 */
export type SessionRow = typeof sessions.$inferSelect;

/** 会话查询过滤条件 */
export interface SessionFilter {
  state?: TaskState;
  toolId?: string;
  limit?: number;
  states?: TaskState[];
  q?: string;
  before?: { updatedAt: string; sessionId: string };
}

function sessionConditions(filter: SessionFilter) {
  const conditions: (SQL | undefined)[] = [eq(sessions.visible, 1)];
  if (filter.state) conditions.push(eq(sessions.currentState, filter.state));
  if (filter.states) conditions.push(inArray(sessions.currentState, filter.states));
  if (filter.toolId) conditions.push(eq(sessions.toolId, filter.toolId));
  if (filter.q?.trim()) {
    const term = `%${filter.q.trim().replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(
      or(
        sql`${sessions.title} LIKE ${term} ESCAPE '\\'`,
        sql`${sessions.toolId} LIKE ${term} ESCAPE '\\'`,
        sql`${sessions.sessionId} LIKE ${term} ESCAPE '\\'`,
      ),
    );
  }
  if (filter.before) {
    conditions.push(
      or(
        lt(sessions.updatedAt, filter.before.updatedAt),
        and(
          eq(sessions.updatedAt, filter.before.updatedAt),
          lt(sessions.sessionId, filter.before.sessionId),
        ),
      ),
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

/** @description: 聚合完整匹配结果，不受当前页条数影响。 */
export function countSessions(db: AppDb, filter: SessionFilter = {}): number {
  return Number(
    db
      .select({ value: count() })
      .from(sessions)
      .where(sessionConditions({ ...filter, before: undefined }))
      .get()?.value ?? 0,
  );
}

/**
 * 按 id 查询单个会话。
 * @param db 数据库句柄
 * @param sessionId 会话 id
 * @returns 会话行，不存在时返回 undefined
 */
export function getSession(db: AppDb, sessionId: string): SessionRow | undefined {
  return db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).get();
}

/** @description: 仅修正标题元数据；不创建会话、不改变状态或时间，也不追加事件。 */
export function updateSessionTitle(db: AppDb, sessionId: string, title: string | null): boolean {
  const result = db
    .update(sessions)
    .set({ title })
    .where(and(eq(sessions.sessionId, sessionId), sql`${sessions.title} IS NOT ${title}`))
    .run();
  return result.changes > 0;
}

function sourceIdentityCondition(baseSessionId: string): SQL | undefined {
  const prefix = baseSessionId + ':turn:';
  const pattern = prefix.replace(/[\\%_]/g, '\\$&') + '%';
  return or(
    eq(sessions.sessionId, baseSessionId),
    and(
      sql`${sessions.sessionId} LIKE ${pattern} ESCAPE '\\'`,
      // SQLite LIKE 默认忽略 ASCII 大小写；ID 前缀仍须精确匹配。
      sql`substr(${sessions.sessionId}, 1, length(${prefix})) = ${prefix}`,
    ),
  );
}

/** @description: 通过来源及开始时间关联没有原生轮次身份的 hook，最近的轮次排在首位。 */
export function listSourceSessions(
  db: AppDb,
  baseSessionId: string,
  options: { startedAtOrBefore?: string; states?: TaskState[] } = {},
): SessionRow[] {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.visible, 1),
        sourceIdentityCondition(baseSessionId),
        options.startedAtOrBefore ? lte(sessions.startedAt, options.startedAtOrBefore) : undefined,
        options.states ? inArray(sessions.currentState, options.states) : undefined,
      ),
    )
    .orderBy(desc(sessions.startedAt), desc(sessions.sessionId))
    .all();
}

/** @description: 仅切换来源及其任务轮次的可见性，不改元数据、状态或事件。 */
export function setSourceSessionsVisibility(
  db: AppDb,
  baseSessionId: string,
  visible: boolean,
): boolean {
  const value = visible ? 1 : 0;
  const result = db
    .update(sessions)
    .set({ visible: value })
    .where(and(ne(sessions.visible, value), sourceIdentityCondition(baseSessionId)))
    .run();
  return result.changes > 0;
}

/**
 * 查询会话列表，默认按更新时间倒序。
 * @param db 数据库句柄
 * @param filter 过滤条件（状态、工具、条数）
 * @returns 会话行列表
 */
export function listSessions(db: AppDb, filter: SessionFilter = {}): SessionRow[] {
  const query = db
    .select()
    .from(sessions)
    .where(sessionConditions(filter))
    .orderBy(desc(sessions.updatedAt), desc(sessions.sessionId))
    .limit(filter.limit ?? 50);
  return query.all();
}

/**
 * 按工具分组统计会话数（GROUP BY 下推到 SQL，避免全表捞回应用层数）。
 * 仅 running / waiting_human 属于活跃会话，已完成或失败记录不计入。
 * @param db 数据库句柄
 * @returns toolId → 会话数 的映射
 */
export function countActiveByTool(db: AppDb): Map<string, number> {
  const rows = db
    .select({ toolId: sessions.toolId, count: count() })
    .from(sessions)
    .where(
      and(eq(sessions.visible, 1), inArray(sessions.currentState, ['running', 'waiting_human'])),
    )
    .groupBy(sessions.toolId)
    .all();
  return new Map(rows.map((row) => [row.toolId, Number(row.count)]));
}

/**
 * 确保会话行存在（懒创建）。
 * 用于 tool.detected / anomaly 等没有前置 started 事件的场景：
 * state_events.session_id 有外键约束，直接插事件行会因会话缺失而失败。
 * 已存在的行完全不碰（onConflictDoNothing），不会覆盖真实状态。
 * @param db 数据库句柄
 * @param input 会话标识与初始状态
 */
export function ensureSessionRow(
  db: AppDb,
  input: { sessionId: string; toolId: string; state: TaskState; ts: string },
): void {
  db.insert(sessions)
    .values({
      sessionId: input.sessionId,
      toolId: input.toolId,
      project: null,
      title: null,
      currentState: input.state,
      startedAt: null,
      endedAt: null,
      updatedAt: input.ts,
    })
    .onConflictDoNothing()
    .run();
}

/**
 * 按状态分组统计会话数（总览页卡片数据源）。
 * @param db 数据库句柄
 * @returns currentState → 会话数 的映射，无会话的状态不出现在结果中
 */
export function countByState(db: AppDb): Map<string, number> {
  const rows = db
    .select({ state: sessions.currentState, count: count() })
    .from(sessions)
    .where(eq(sessions.visible, 1))
    .groupBy(sessions.currentState)
    .all();
  return new Map(rows.map((row) => [row.state, Number(row.count)]));
}
