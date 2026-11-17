CREATE INDEX IF NOT EXISTS idx_events_session_attention ON state_events(session_id, next_state, julianday(ts) DESC) WHERE event_type IN ('task.waiting_human','task.failed','task.timeout');
CREATE INDEX IF NOT EXISTS idx_notifications_unread_attention ON notifications(session_id) WHERE read=0 AND level='attention';
