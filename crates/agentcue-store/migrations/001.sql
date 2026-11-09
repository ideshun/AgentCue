
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
