/**
 * 建库迁移脚本（对齐详细设计 5.2 DDL、5.9 幂等迁移要求）。
 * 以 TS 常量形式内联，避免打包后 SQL 文件丢失；版本号写入 SQLite user_version 保证幂等。
 */
export interface Migration {
  /** 迁移版本号，写入 user_version */
  version: number;
  /** 迁移名称，用于错误提示 */
  name: string;
  /** DDL 语句 */
  sql: string;
}

/** 初始建表脚本 */
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS tools (
  tool_id          TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  adapter_id       TEXT NOT NULL,
  detect_status    TEXT NOT NULL CHECK (detect_status IN ('installed','running','not_installed','unknown')),
  version          TEXT,
  config_path      TEXT,
  executable_path  TEXT,
  ignored          INTEGER NOT NULL DEFAULT 0,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  tool_id        TEXT NOT NULL REFERENCES tools(tool_id),
  project        TEXT,
  title          TEXT,
  current_state  TEXT NOT NULL CHECK (current_state IN
    ('idle','running','waiting_human','failed','completed','cancelled','timeout')),
  started_at     TEXT,
  ended_at       TEXT,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions (current_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS state_events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  tool_id      TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  prev_state   TEXT,
  next_state   TEXT,
  actor        TEXT NOT NULL CHECK (actor IN ('tool','human','system','mcp')),
  reason       TEXT,
  ts           TEXT NOT NULL,
  payload      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON state_events (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON state_events (event_type, ts);
CREATE INDEX IF NOT EXISTS idx_events_state ON state_events (next_state, ts);

CREATE TABLE IF NOT EXISTS voice_rules (
  rule_id     TEXT PRIMARY KEY,
  scope_tool  TEXT,
  scope_event TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('mute','notify','speak')),
  template    TEXT,
  priority    TEXT CHECK (priority IN ('low','mid','high')),
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  server_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  transport  TEXT NOT NULL CHECK (transport IN ('stdio','streamable-http')),
  command    TEXT,
  args       TEXT,
  url        TEXT,
  status     TEXT NOT NULL DEFAULT 'disconnected',
  tools      TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  result  TEXT
);
`;

/** 通知中心与检索辅助（FR-24） */
const V2_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  ts              TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  level           TEXT NOT NULL,
  read            INTEGER NOT NULL DEFAULT 0,
  session_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications (ts DESC);
`;

/** 迁移清单，按顺序执行 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: INIT_SQL },
  { version: 2, name: 'notifications', sql: V2_SQL },
  {
    version: 3,
    name: 'source-checkpoints-and-mcp-validation',
    sql: `
CREATE TABLE source_checkpoints (
  source_path TEXT PRIMARY KEY, tool_id TEXT NOT NULL, file_identity TEXT NOT NULL,
  byte_offset INTEGER NOT NULL, prefix_hash TEXT NOT NULL, title TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE source_receipts (event_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL);
ALTER TABLE mcp_servers ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE mcp_servers ADD COLUMN last_validated_at TEXT;
ALTER TABLE mcp_servers ADD COLUMN last_error TEXT;
UPDATE mcp_servers SET status = 'disconnected';
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC, session_id DESC);
`,
  },
  {
    version: 4,
    name: 'source-task-context',
    sql: 'ALTER TABLE source_checkpoints ADD COLUMN context TEXT;',
  },
  {
    version: 5,
    name: 'session-visibility',
    sql: 'ALTER TABLE sessions ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;',
  },
] as const;
