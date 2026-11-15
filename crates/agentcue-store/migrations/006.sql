CREATE INDEX idx_sessions_board_state ON sessions(current_state, julianday(updated_at), session_id) WHERE visible=1;
CREATE INDEX idx_events_tool_milestones ON state_events(tool_id, event_type, julianday(ts)) WHERE actor='tool';
