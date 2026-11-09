
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
