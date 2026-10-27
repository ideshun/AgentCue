/**
 * 控制 API / MCP 统一响应契约（详细设计 5.5、5.7）。
 * 所有对外返回走同一 envelope，错误统一三元组。
 */
import { z } from 'zod';
import { eventTypeSchema, isoTimestampSchema } from './event';
import { taskStateSchema } from './state';

/** 错误码枚举 */
export const ERROR_CODES = [
  'NOT_FOUND',
  'INVALID_PARAM',
  'ILLEGAL_TRANSITION',
  'RATE_LIMITED',
  'ENGINE_UNAVAILABLE',
] as const;

/** 错误码类型 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 错误码 Zod 校验器 */
export const errorCodeSchema = z.enum(ERROR_CODES);

/** 成功响应 */
export const successEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.unknown().optional(),
});

/** 失败响应 */
export const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
  }),
  details: z.unknown().optional(),
  suggestion: z.string().optional(),
});

/** 统一响应封套 */
export const envelopeSchema = z.union([successEnvelopeSchema, errorEnvelopeSchema]);

/** 成功响应类型 */
export type SuccessEnvelope = z.infer<typeof successEnvelopeSchema>;

/** 失败响应类型 */
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** 统一响应类型 */
export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * MCP 工具入参契约（详细设计 5.7）。
 * 工具签名只增不改，破坏性变更走新工具名。
 */

/** list_tools 入参 */
export const listToolsInputSchema = z.object({});

/** list_sessions 入参 */
export const listSessionsInputSchema = z.object({
  state: taskStateSchema.optional(),
  toolId: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/** get_task_status 入参 */
export const getTaskStatusInputSchema = z.object({
  sessionId: z.string().min(1),
});

/** MCP 允许注入的事件白名单 */
export const MCP_UPDATABLE_EVENTS = [
  'human.responded',
  'task.retried',
  'task.archived',
  'task.cancelled',
] as const;

/** MCP 可注入事件类型 */
export type McpUpdatableEvent = (typeof MCP_UPDATABLE_EVENTS)[number];

/** update_task_state 入参 */
export const updateTaskStateInputSchema = z.object({
  sessionId: z.string().min(1),
  event: z.enum(MCP_UPDATABLE_EVENTS),
  reason: z.string().optional(),
});

/** 播报动作三元组 */
export const VOICE_ACTIONS = ['mute', 'notify', 'speak'] as const;

/** 播报动作类型 */
export type VoiceAction = (typeof VOICE_ACTIONS)[number];

/** 播报规则优先级 */
export const VOICE_PRIORITIES = ['low', 'mid', 'high'] as const;

/** 播报优先级类型 */
export type VoicePriority = (typeof VOICE_PRIORITIES)[number];

/** set_voice_rule 入参，幂等 upsert */
export const setVoiceRuleInputSchema = z.object({
  scopeTool: z.string().optional(),
  scopeEvent: z.string().min(1),
  action: z.enum(VOICE_ACTIONS),
  template: z.string().optional(),
  priority: z.enum(VOICE_PRIORITIES).optional(),
});

/** get_timeline 入参 */
export const getTimelineInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(500).default(50),
});

/** 事件查询入参：eventType 走白名单，limit 设上限，避免一次拉走全表 */
export const searchEventsInputSchema = z.object({
  eventType: eventTypeSchema.optional(),
  toolId: z.string().optional(),
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

/** 通知列表入参：offset 支持向后翻页 */
export const listNotificationsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});
