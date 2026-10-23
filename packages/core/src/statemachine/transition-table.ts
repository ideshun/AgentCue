/**
 * 任务状态迁移表（产品方案 7.3、FLOW-02）。
 * 这是迁移合法性的唯一权威，XState 定义必须与本表保持一致（由单测断言）。
 */
import type { ErrorCode, EventType, TaskState } from '@awm/schema';

/** 单个状态可接受的迁移：事件类型 → 目标状态 */
export type TransitionRow = Partial<Record<EventType, TaskState>>;

/** 迁移表：当前状态 → 可接受迁移 */
export const TRANSITION_TABLE: Record<TaskState, TransitionRow> = {
  idle: {
    'task.started': 'running',
  },
  running: {
    'task.waiting_human': 'waiting_human',
    'task.failed': 'failed',
    'task.completed': 'completed',
    'task.cancelled': 'cancelled',
    'heartbeat.lost': 'timeout',
  },
  waiting_human: {
    'human.responded': 'running',
    'task.timeout': 'timeout',
    'task.cancelled': 'cancelled',
    'heartbeat.lost': 'timeout',
  },
  failed: {
    'task.retried': 'running',
    'task.archived': 'idle',
  },
  timeout: {
    'task.retried': 'running',
    'task.archived': 'idle',
  },
  // 约束 4：completed → running 被拒绝，只允许新建实例或显式 retried
  completed: {
    'task.archived': 'idle',
  },
  cancelled: {
    'task.archived': 'idle',
  },
};

/** 非法迁移错误，code 对齐 MCP 错误三元组 */
export class IllegalTransitionError extends Error {
  /** 错误码，统一为 ILLEGAL_TRANSITION */
  public readonly code: ErrorCode = 'ILLEGAL_TRANSITION';

  /** 迁移前的状态 */
  public readonly prevState: TaskState;

  /** 触发的事件类型 */
  public readonly eventType: EventType;

  /**
   * @param prevState 迁移前状态
   * @param eventType 触发事件
   */
  constructor(prevState: TaskState, eventType: EventType) {
    super(`非法状态迁移：${prevState} 不接受事件 ${eventType}`);
    this.name = 'IllegalTransitionError';
    this.prevState = prevState;
    this.eventType = eventType;
  }
}

/**
 * 查询迁移目标。
 * @param prevState 迁移前状态
 * @param eventType 触发事件
 * @returns 目标状态；非法迁移返回 null（回跳防护等场景）
 */
export function resolveTransition(prevState: TaskState, eventType: EventType): TaskState | null {
  const row: TransitionRow = TRANSITION_TABLE[prevState];
  const next = row[eventType];
  return next ?? null;
}

/**
 * 判断迁移是否合法。
 * @param prevState 迁移前状态
 * @param eventType 触发事件
 * @returns 是否为合法迁移
 */
export function isLegalTransition(prevState: TaskState, eventType: EventType): boolean {
  return resolveTransition(prevState, eventType) !== null;
}

/**
 * 强制执行迁移，非法时抛错。
 * @param prevState 迁移前状态
 * @param eventType 触发事件
 * @returns 目标状态
 * @throws 非法迁移时抛出 IllegalTransitionError
 */
export function requireTransition(prevState: TaskState, eventType: EventType): TaskState {
  const next = resolveTransition(prevState, eventType);
  if (next === null) {
    throw new IllegalTransitionError(prevState, eventType);
  }
  return next;
}
