/**
 * Drizzle 表定义，逐字段对齐详细设计 5.2 的 SQLite DDL。
 * 时间统一存 ISO 8601 字符串，索引与 DDL 保持一致。
 */
import { desc } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** 工具清单（FR-01/03） */
export const tools = sqliteTable('tools', {
  toolId: text('tool_id').primaryKey(),
  name: text('name').notNull(),
  adapterId: text('adapter_id').notNull(),
  /** 四态之一：installed / running / not_installed / unknown */
  detectStatus: text('detect_status').notNull(),
  version: text('version'),
  configPath: text('config_path'),
  executablePath: text('executable_path'),
  ignored: integer('ignored').notNull().default(0),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
});

/** 会话（1 工具 N 会话） */
export const sessions = sqliteTable(
  'sessions',
  {
    sessionId: text('session_id').primaryKey(),
    toolId: text('tool_id')
      .notNull()
      .references(() => tools.toolId),
    project: text('project'),
    title: text('title'),
    /** 内部来源保留元数据，但不进入任务看板或统计。 */
    visible: integer('visible').notNull().default(1),
    currentState: text('current_state').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    updatedAt: text('updated_at').notNull(),
  },
  // 索引第二列降序，对齐 DDL 的 (current_state, updated_at DESC)
  (t) => [index('idx_sessions_state').on(t.currentState, desc(t.updatedAt))],
);

/** 状态事件日志（只追加，FR-06/10） */
export const stateEvents = sqliteTable(
  'state_events',
  {
    eventId: text('event_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId),
    toolId: text('tool_id').notNull(),
    eventType: text('event_type').notNull(),
    prevState: text('prev_state'),
    nextState: text('next_state'),
    actor: text('actor').notNull(),
    reason: text('reason'),
    ts: text('ts').notNull(),
    /** JSON 字符串 */
    payload: text('payload'),
  },
  (t) => [
    index('idx_events_session').on(t.sessionId, t.ts),
    index('idx_events_type_ts').on(t.eventType, t.ts),
    index('idx_events_state').on(t.nextState, t.ts),
  ],
);

/** 播报规则（FR-11/12/15） */
export const voiceRules = sqliteTable('voice_rules', {
  ruleId: text('rule_id').primaryKey(),
  /** NULL 表示全部工具 */
  scopeTool: text('scope_tool'),
  scopeEvent: text('scope_event').notNull(),
  /** mute / notify / speak */
  action: text('action').notNull(),
  template: text('template'),
  priority: text('priority'),
  updatedAt: text('updated_at').notNull(),
});

/** 外部 MCP Server（FR-18） */
export const mcpServers = sqliteTable('mcp_servers', {
  serverId: text('server_id').primaryKey(),
  name: text('name').notNull(),
  transport: text('transport').notNull(),
  command: text('command'),
  args: text('args'),
  url: text('url'),
  status: text('status').notNull().default('disconnected'),
  /** JSON 数组 */
  tools: text('tools'),
  validationStatus: text('validation_status').notNull().default('unverified'),
  lastValidatedAt: text('last_validated_at'),
  lastError: text('last_error'),
});

/** 已提交的来源位置，不与心跳观测共享。 */
export const sourceCheckpoints = sqliteTable('source_checkpoints', {
  sourcePath: text('source_path').primaryKey(),
  toolId: text('tool_id').notNull(),
  fileIdentity: text('file_identity').notNull(),
  offset: integer('byte_offset').notNull(),
  prefixHash: text('prefix_hash').notNull(),
  title: text('title'),
  context: text('context'),
  updatedAt: text('updated_at').notNull(),
});
export const sourceReceipts = sqliteTable('source_receipts', {
  eventId: text('event_id').primaryKey(),
  processedAt: text('processed_at').notNull(),
});

/** 审计（FR-20 / C-07） */
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: text('ts').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target'),
  result: text('result'),
});

/** 通知中心（FR-24） */
export const notifications = sqliteTable('notifications', {
  notificationId: text('notification_id').primaryKey(),
  ts: text('ts').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  level: text('level').notNull(),
  read: integer('read').notNull().default(0),
  sessionId: text('session_id'),
});

/** 全表集合，供 drizzle(schema) 与查询构造使用 */
export const schema = {
  tools,
  sessions,
  stateEvents,
  voiceRules,
  mcpServers,
  sourceCheckpoints,
  sourceReceipts,
  auditLog,
  notifications,
} as const;
