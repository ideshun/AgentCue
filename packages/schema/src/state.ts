/**
 * 任务状态定义（详细设计 5.2 `sessions.current_state`、产品方案 7.3 状态迁移表）。
 * 这是全仓状态取值的唯一事实源，任何模块不得自造平行枚举。
 */
import { z } from 'zod';

/** 任务的 7 个状态 */
export const TASK_STATES = [
  'idle',
  'running',
  'waiting_human',
  'failed',
  'completed',
  'cancelled',
  'timeout',
] as const;

/** 单个任务状态 */
export type TaskState = (typeof TASK_STATES)[number];

/** 状态 Zod 校验器 */
export const taskStateSchema = z.enum(TASK_STATES);

/**
 * 类终态：处于这些状态时禁止直接回跳 running，
 * 必须显式经 `task.retried`（failed/timeout）或 `task.archived` 回到 idle。
 * 对应产品方案 7.3 约束 4 的回跳防护。
 */
export const TERMINAL_LIKE_STATES = ['completed', 'cancelled'] as const;

/** 类终态类型 */
export type TerminalLikeState = (typeof TERMINAL_LIKE_STATES)[number];

/**
 * 判断是否类终态。
 * @param state 待判定的任务状态
 * @returns 是否为 completed / cancelled
 */
export function isTerminalLike(state: TaskState): state is TerminalLikeState {
  return (TERMINAL_LIKE_STATES as readonly TaskState[]).includes(state);
}

/** 工具探测四态（详细设计 FLOW-01 第 4 步） */
export const DETECT_STATUSES = ['installed', 'running', 'not_installed', 'unknown'] as const;

/** 工具探测状态 */
export type DetectStatus = (typeof DETECT_STATUSES)[number];

/** 工具探测状态 Zod 校验器 */
export const detectStatusSchema = z.enum(DETECT_STATUSES);
