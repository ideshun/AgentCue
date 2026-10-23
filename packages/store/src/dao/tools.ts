/**
 * tools 表 DAO（FR-01/03，FLOW-01 第 5 步 upsert）。
 */
import { eq } from 'drizzle-orm';
import type { DetectStatus } from '@awm/schema';
import type { AppDb } from '../db';
import { tools } from '../schema';

/** tools 表行类型 */
export type ToolRow = typeof tools.$inferSelect;

/** 写入工具记录的入参 */
export interface UpsertToolInput {
  /** 适配器 id，同时作为主键 */
  toolId: string;
  name: string;
  adapterId: string;
  detectStatus: DetectStatus;
  version?: string | null;
  configPath?: string | null;
  executablePath?: string | null;
}

/**
 * 写入或更新工具记录。已存在时只刷新探测结果与 last_seen_at，保留 first_seen_at。
 * @param db 数据库句柄
 * @param input 工具探测结果
 */
export function upsertTool(db: AppDb, input: UpsertToolInput): void {
  const now = new Date().toISOString();
  db.insert(tools)
    .values({
      toolId: input.toolId,
      name: input.name,
      adapterId: input.adapterId,
      detectStatus: input.detectStatus,
      version: input.version ?? null,
      configPath: input.configPath ?? null,
      executablePath: input.executablePath ?? null,
      ignored: 0,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: tools.toolId,
      set: {
        name: input.name,
        adapterId: input.adapterId,
        detectStatus: input.detectStatus,
        version: input.version ?? null,
        configPath: input.configPath ?? null,
        executablePath: input.executablePath ?? null,
        lastSeenAt: now,
      },
    })
    .run();
}

/**
 * 查询全部工具。
 * @param db 数据库句柄
 * @returns 工具行列表
 */
export function listTools(db: AppDb): ToolRow[] {
  return db.select().from(tools).all();
}

/**
 * 设置工具的忽略标记，被忽略的工具不参与扫描。
 * @param db 数据库句柄
 * @param toolId 工具 id
 * @param ignored 是否忽略
 */
export function setToolIgnored(db: AppDb, toolId: string, ignored: boolean): void {
  db.update(tools).set({ ignored: ignored ? 1 : 0 }).where(eq(tools.toolId, toolId)).run();
}
