
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
