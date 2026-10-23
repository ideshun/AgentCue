/**
 * 标准事件定义（详细设计 5.3）。
 * 同一 Zod 定义同时服务：适配器输出校验、WS 消息体、MCP 入参、测试夹具。
 * 禁止任何模块自造平行类型。
 */
import { z } from 'zod';

/**
 * 事件类型全集。
 *
 * 说明：详细设计 5.3 列出 10 类（7 类 + heartbeat.lost / tool.detected / anomaly）。
 * 实现补充 2 类，否则契约无法自洽：
 * - `task.timeout`：FLOW-02 中 waiting_human 的 30 分钟介入倒计时超时事件
 * - `task.cancelled`：5.7 MCP `update_task_state` 白名单中声明的可注入事件
 * 该差异已记录为 ADR-11（见 docs/design/detailed-design.md 第 11 章待补充项）。
 */
export const EVENT_TYPES = [
  'task.started',
  'task.waiting_human',
  'human.responded',
  'task.failed',
  'task.completed',
  'task.retried',
  'task.archived',
  'task.timeout',
  'task.cancelled',
  'heartbeat.lost',
  'tool.detected',
  'anomaly',
] as const;

/** 事件类型 */
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * 非迁移类事件：不改变任务状态，仅追加记录。
 * 迁移表中没有这些事件的边（详见 transition-table），
 * 引擎收到它们时应直接落库而不推进状态机，也不得判为「非法迁移」。
 */
export const NON_TRANSITION_EVENT_TYPES = ['anomaly', 'tool.detected'] as const;

/** 非迁移类事件类型 */
export type NonTransitionEventType = (typeof NON_TRANSITION_EVENT_TYPES)[number];

/** 事件类型 Zod 校验器 */
export const eventTypeSchema = z.enum(EVENT_TYPES);

/** 事件发起方四元组 */
export const EVENT_ACTORS = ['tool', 'human', 'system', 'mcp'] as const;

/** 事件发起方 */
export type EventActor = (typeof EVENT_ACTORS)[number];

/** 事件发起方 Zod 校验器 */
export const eventActorSchema = z.enum(EVENT_ACTORS);

/** 标准事件载荷：已声明字段保留，其余走 unknown 收窄，禁止 any */
export const eventPayloadSchema = z
  .object({
    /** 任务标题，用于播报模板 `{title}` */
    taskTitle: z.string().optional(),
    /** 迁移原因，落 state_events.reason */
    reason: z.string().optional(),
    /** 心跳序号，用于乱序补正 */
    heartbeatSeq: z.number().int().nonnegative().optional(),
  })
  .catchall(z.unknown());

/** 事件载荷类型 */
export type EventPayload = z.infer<typeof eventPayloadSchema>;

/**
 * ISO 8601 时间戳校验：同时接受 `Z` 与 `+08:00` 形式。
 * 不使用 zod 的 datetime()：其 offset 模式会拒绝 Z 结尾，与适配器实际输出不兼容。
 */
export const isoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/,
    'occurredAt 需为 ISO 8601 时间戳（如 2026-10-19T10:00:00.000Z 或 +08:00 偏移）',
  );

/** 标准事件 */
export const standardEventSchema = z.object({
  /** "evt_" + ULID */
  eventId: z.string().startsWith('evt_'),
  /** "{toolId}:{project}:{sessKey}" */
  sessionId: z.string().min(1),
  /** 适配器 id */
  toolId: z.string().min(1),
  eventType: eventTypeSchema,
  /** ISO 8601 时间戳 */
  occurredAt: isoTimestampSchema,
  actor: eventActorSchema,
  payload: eventPayloadSchema.default({}),
  /** 用于事件结构的兼容演进 */
  schemaVersion: z.literal(1),
});

/** 标准事件类型 */
export type StandardEvent = z.infer<typeof standardEventSchema>;

/**
 * 事件 ID 前缀，构造与校验共用。
 */
export const EVENT_ID_PREFIX = 'evt_';
