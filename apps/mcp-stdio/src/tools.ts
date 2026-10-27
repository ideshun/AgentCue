/**
 * MCP 工具名与入参 schema（M2、详细设计 5.7）。
 *
 * 与 @awm/core 的 MCP_TOOL_NAMES 保持一致，由 tests/contract/mcp-tools.test.ts 断言，
 * 避免桥接进程为了拿一个常量而拖入整个 core（含 xstate 与子进程探测）。
 */

import { TASK_STATES, MCP_UPDATABLE_EVENTS } from '@awm/schema';

/** MCP 工具名列表 */
export const TOOL_NAMES = [
  'list_tools',
  'list_sessions',
  'get_task_status',
  'update_task_state',
  'set_voice_rule',
  'get_timeline',
] as const;

/** 工具名类型 */
export type ToolName = (typeof TOOL_NAMES)[number];

/** JSON Schema 子集，仅用于声明入参 */
export interface JsonSchema {
  /** 类型 */
  type: 'object';
  /** 属性 */
  properties: Record<string, unknown>;
  /** 必填字段 */
  required?: string[];
  /** 是否允许额外字段 */
  additionalProperties: boolean;
}

/** 工具定义 */
export interface ToolDefinition {
  /** 工具名 */
  name: ToolName;
  /** 说明，直接影响 AI 是否愿意调用 */
  description: string;
  /** 入参 schema */
  inputSchema: JsonSchema;
}

/** 任务状态枚举 */
const STATE_ENUM = [...TASK_STATES];

/** 6 个工具的完整定义 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_tools',
    description: '列出本机已识别的 AI 编码工具及其探测状态、会话数量。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_sessions',
    description: '按状态或工具筛选任务会话，返回会话 id、标题、当前状态与更新时间。',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: STATE_ENUM, description: '任务状态过滤' },
        toolId: { type: 'string', description: '工具 id 过滤' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_status',
    description: '查询单个会话的当前状态与最近 5 条状态迁移，用于判断任务卡在哪一步。',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', minLength: 1 } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_task_state',
    description:
      '注入一条状态事件。仅允许 human.responded / task.retried / task.archived / task.cancelled；' +
      '这些动作只更新 AgentCue 的状态记录，不会向原工具发送操作；completed 只能先归档。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        event: {
          type: 'string',
          enum: [...MCP_UPDATABLE_EVENTS],
        },
        reason: { type: 'string', description: '写入审计日志的原因' },
      },
      required: ['sessionId', 'event'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_voice_rule',
    description:
      '幂等写入播报规则：同一作用域重复调用是更新而非新增。动作取值 mute / notify / speak。',
    inputSchema: {
      type: 'object',
      properties: {
        scopeTool: { type: 'string', description: '作用工具，省略表示全部工具' },
        scopeEvent: { type: 'string', description: '作用事件类型，* 表示全部' },
        action: { type: 'string', enum: ['mute', 'notify', 'speak'] },
        template: { type: 'string', description: '播报模板，支持 {tool} {title} {event}' },
        priority: { type: 'string', enum: ['low', 'mid', 'high'] },
      },
      required: ['scopeEvent', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_timeline',
    description: '查询会话的状态迁移时间线，按时间倒序返回（最新的一条在最前）。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
];
