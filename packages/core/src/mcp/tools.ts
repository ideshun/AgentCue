/**
 * MCP Server 的 6 个工具实现（SM-4.1、详细设计 5.7、FLOW-05）。
 *
 * 依赖倒置：core 不直接依赖 store，宿主（桌面主进程）注入 EngineFacade 实现。
 * 统一返回 envelope，错误走三元组：NOT_FOUND / INVALID_PARAM / ILLEGAL_TRANSITION /
 * RATE_LIMITED / ENGINE_UNAVAILABLE。
 */
import {
  errorCodeSchema,
  getTaskStatusInputSchema,
  getTimelineInputSchema,
  listSessionsInputSchema,
  setVoiceRuleInputSchema,
  updateTaskStateInputSchema,
  type Envelope,
  type ErrorCode,
  type TaskState,
} from '@awm/schema';
import { IllegalTransitionError } from '../statemachine/transition-table';
import type { VoiceRule } from '../voice/rule-engine';

/** 工具摘要 */
export interface ToolSummary {
  /** 工具 id */
  toolId: string;
  /** 展示名 */
  name: string;
  /** 探测状态 */
  detectStatus: string;
  /** 版本 */
  version?: string | null;
  /** 活跃会话数 */
  sessionCount: number;
  sessionCapability?: 'events' | 'metadata' | 'detect-only';
  capabilityReason?: string;
  host?: string;
  ignored?: boolean;
}

/** 会话摘要 */
export interface SessionSummary {
  /** 会话 id */
  sessionId: string;
  /** 工具 id */
  toolId: string;
  /** 标题 */
  title?: string | null;
  /** 当前状态 */
  currentState: TaskState;
  /** 更新时间 */
  updatedAt: string;
}

/** 迁移记录 */
export interface TransitionRecord {
  /** 事件 id */
  eventId: string;
  /** 会话 id */
  sessionId: string;
  /** 事件类型 */
  eventType: string;
  /** 迁移前状态 */
  prevState: TaskState | null;
  /** 迁移后状态 */
  nextState: TaskState | null;
  /** 发起方 */
  actor: string;
  /** 原因 */
  reason?: string | null;
  /** 时间 */
  ts: string;
}

/** 迁移结果 */
export interface TransitionResult {
  /** 会话 id */
  sessionId: string;
  /** 迁移前状态 */
  prevState: TaskState;
  /** 迁移后状态 */
  nextState: TaskState;
  /** 事件类型 */
  eventType: string;
  /** 时间 */
  ts: string;
}

/** 引擎门面：宿主实现，core 只依赖该接口 */
export interface EngineFacade {
  /**
   * 列出工具。
   * @returns 工具摘要列表
   */
  listTools(): Promise<ToolSummary[]>;
  /**
   * 查询会话。
   * @param filter 过滤条件
   * @returns 会话摘要列表
   */
  listSessions(filter: {
    state?: TaskState;
    toolId?: string;
    limit?: number;
  }): Promise<SessionSummary[]>;
  /**
   * 查询任务状态。
   * @param sessionId 会话 id
   * @returns 状态与最近迁移，不存在返回 null
   */
  getTaskStatus(
    sessionId: string,
  ): Promise<{ state: TaskState; recent: TransitionRecord[] } | null>;
  /**
   * 更新任务状态。
   * @param input 更新入参
   * @returns 迁移结果
   * @throws 会话不存在时返回 null，非法迁移抛 IllegalTransitionError
   */
  updateTaskState(input: {
    sessionId: string;
    event: string;
    reason?: string;
  }): Promise<TransitionResult | null>;
  /**
   * 幂等写入播报规则。
   * @param input 规则入参
   * @returns 规则对象
   */
  setVoiceRule(input: {
    scopeTool?: string;
    scopeEvent: string;
    action: string;
    template?: string;
    priority?: string;
  }): Promise<VoiceRule>;
  /**
   * 查询迁移时间线。
   * @param sessionId 会话 id
   * @param limit 条数
   * @returns 迁移记录
   */
  getTimeline(sessionId: string, limit: number): Promise<TransitionRecord[]>;
}

/** MCP 工具名 */
export const MCP_TOOL_NAMES = [
  'list_tools',
  'list_sessions',
  'get_task_status',
  'update_task_state',
  'set_voice_rule',
  'get_timeline',
] as const;

/** MCP 工具名类型 */
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** 工具处理函数 */
export type McpHandler = (input: unknown) => Promise<Envelope>;

/**
 * 构造成功响应。
 * @param data 返回数据
 * @returns 成功 envelope
 */
function ok(data?: unknown): Envelope {
  return { success: true, data };
}

/**
 * 构造失败响应。
 * @param code 错误码
 * @param message 错误描述
 * @param suggestion 修复建议
 * @returns 失败 envelope
 */
function fail(code: ErrorCode, message: string, suggestion?: string): Envelope {
  return { success: false, error: { code: errorCodeSchema.parse(code), message }, suggestion };
}

/**
 * 注册 6 个 MCP 工具。
 * @param facade 引擎门面
 * @returns 工具名 → 处理函数的映射
 */
export function createMcpTools(facade: EngineFacade): Record<McpToolName, McpHandler> {
  return {
    async list_tools() {
      try {
        return ok(await facade.listTools());
      } catch (error) {
        return fail('ENGINE_UNAVAILABLE', describeError(error));
      }
    },

    async list_sessions(input) {
      const parsed = listSessionsInputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        return fail('INVALID_PARAM', '入参校验失败', parsed.error.message);
      }
      return ok(await facade.listSessions(parsed.data));
    },

    async get_task_status(input) {
      const parsed = getTaskStatusInputSchema.safeParse(input);
      if (!parsed.success) {
        return fail('INVALID_PARAM', '入参校验失败', parsed.error.message);
      }
      const status = await facade.getTaskStatus(parsed.data.sessionId);
      if (!status) {
        return fail('NOT_FOUND', `会话不存在：${parsed.data.sessionId}`);
      }
      return ok(status);
    },

    async update_task_state(input) {
      const parsed = updateTaskStateInputSchema.safeParse(input);
      if (!parsed.success) {
        return fail('INVALID_PARAM', '入参校验失败', parsed.error.message);
      }
      try {
        const result = await facade.updateTaskState(parsed.data);
        if (!result) {
          return fail('NOT_FOUND', `会话不存在：${parsed.data.sessionId}`);
        }
        return ok(result);
      } catch (error) {
        if (error instanceof IllegalTransitionError) {
          return fail(
            'ILLEGAL_TRANSITION',
            error.message,
            '请改用 task.retried 显式重试，或 task.archived 归档后重新开始',
          );
        }
        return fail('ENGINE_UNAVAILABLE', describeError(error));
      }
    },

    async set_voice_rule(input) {
      const parsed = setVoiceRuleInputSchema.safeParse(input);
      if (!parsed.success) {
        return fail('INVALID_PARAM', '入参校验失败', parsed.error.message);
      }
      return ok(await facade.setVoiceRule(parsed.data));
    },

    async get_timeline(input) {
      const parsed = getTimelineInputSchema.safeParse(input);
      if (!parsed.success) {
        return fail('INVALID_PARAM', '入参校验失败', parsed.error.message);
      }
      return ok(await facade.getTimeline(parsed.data.sessionId, parsed.data.limit));
    },
  };
}

/**
 * 提取错误信息。
 * @param error 未知错误
 * @returns 错误描述
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
