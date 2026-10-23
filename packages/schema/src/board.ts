import { z } from 'zod';
import type { TaskState } from './state';

export const BOARD_GROUPS = ['attention', 'running', 'failed', 'completed', 'history'] as const;
export type BoardGroupId = (typeof BOARD_GROUPS)[number];

export const boardQuerySchema = z.object({
  q: z.string().max(200).optional(),
  toolId: z.string().max(200).optional(),
  group: z.enum(BOARD_GROUPS).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

/** 历史索引记录与工作流会话共用展示结构，但不混用状态语义。 */
export interface BoardItem {
  kind: 'session' | 'history';
  sessionId: string;
  toolId: string;
  title: string | null;
  currentState: TaskState | null;
  updatedAt: string;
  sourceStatus?: string;
}
export interface BoardPage {
  id: BoardGroupId;
  items: BoardItem[];
  total: number;
  nextCursor: string | null;
}
export interface BoardResponse {
  groups: BoardPage[];
  generatedAt: string;
}

/** 跨读取批次保留当前来源任务及其用户标题，不保存原始消息。 */
export const sourceTaskContextSchema = z.object({
  taskId: z.string().min(1).optional(),
  title: z.string().nullable().optional(),
  closed: z.boolean().optional(),
  pendingTitle: z.string().nullable().optional(),
  /** 首条来源元数据的分类结果；true 表示内部流程，不产生用户任务。 */
  excluded: z.boolean().optional(),
});
export type SourceTaskContext = z.infer<typeof sourceTaskContextSchema>;

export interface SourceCheckpoint {
  sourcePath: string;
  toolId: string;
  fileIdentity: string;
  offset: number;
  prefixHash: string;
  title: string | null;
  context?: SourceTaskContext | null;
  updatedAt: string;
}
