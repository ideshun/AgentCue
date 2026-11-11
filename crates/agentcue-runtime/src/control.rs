//! Shared validated operations for the desktop API and MCP bridge.
use crate::{queries, state::Runtime};
use agentcue_core::{EventType, TaskState, resolve_transition};
use agentcue_store::engine::{Event, ingest_batch};
use rusqlite::{Connection, OptionalExtension, params, types::Value as Sql};
use serde_json::{Value, json};
use std::{collections::HashMap, str::FromStr};

#[derive(Debug)]
pub struct ControlError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}
impl ControlError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code: "INVALID_PARAM",
            message: message.into(),
        }
    }
    pub fn unavailable() -> Self {
        Self {
            status: 500,
            code: "ENGINE_UNAVAILABLE",
            message: "本机服务暂不可用".into(),
        }
    }
    pub fn missing(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            code: "NOT_FOUND",
            message: message.into(),
        }
    }
}
impl From<rusqlite::Error> for ControlError {
    fn from(_: rusqlite::Error) -> Self {
        Self::unavailable()
    }
}
pub type Result<T> = std::result::Result<T, ControlError>;
pub fn string<'a>(body: &'a Value, key: &str) -> Result<&'a str> {
    body.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ControlError::invalid(format!("{key} 须为字符串")))
}
pub fn limit(
    q: &HashMap<String, String>,
    key: &str,
    default: usize,
    min: usize,
    max: usize,
) -> Result<usize> {
    let n = q
        .get(key)
        .map(|v| v.parse::<usize>())
        .transpose()
        .map_err(|_| ControlError::invalid("分页参数无效"))?
        .unwrap_or(default);
    if n < min || n > max {
        return Err(ControlError::invalid("分页参数超出范围"));
    }
    Ok(n)
}
pub fn list_sessions(db: &Connection, q: &HashMap<String, String>) -> Result<Value> {
    let state = q.get("state");
    if let Some(s) = state {
        TaskState::from_str(s).map_err(|_| ControlError::invalid("任务状态无效"))?;
    }
    let states: Vec<&str> = state.map(|s| vec![s.as_str()]).unwrap_or_default();
    Ok(json!(queries::sessions(
        db,
        &states,
        q.get("toolId").map(String::as_str),
        None,
        None,
        limit(q, "limit", 50, 1, 200)?
    )?))
}
pub fn events(db: &Connection, q: &HashMap<String, String>) -> Result<Value> {
    let mut filters = vec![];
    let mut params = vec![];
    for (key, column) in [("type", "event_type"), ("toolId", "tool_id")] {
        if let Some(v) = q.get(key) {
            if key == "type" {
                EventType::from_str(v).map_err(|_| ControlError::invalid("事件类型无效"))?;
            }
            filters.push(format!("{column}=?"));
            params.push(Sql::Text(v.clone()));
        }
    }
    for (key, op) in [("from", ">="), ("to", "<=")] {
        if let Some(v) = q.get(key) {
            chrono::DateTime::parse_from_rfc3339(v)
                .map_err(|_| ControlError::invalid("事件日期无效"))?;
            filters.push(format!("julianday(ts){op}julianday(?)"));
            params.push(Sql::Text(v.clone()));
        }
    }
    params.push(Sql::Integer(limit(q, "limit", 200, 1, 500)? as i64));
    let filter = if filters.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", filters.join(" AND "))
    };
    Ok(json!(queries::rows(
        db,
        &format!(
            "SELECT event_id AS eventId,session_id AS sessionId,event_type AS eventType,prev_state AS prevState,next_state AS nextState,actor,reason,ts FROM state_events {filter} ORDER BY julianday(ts) DESC,rowid DESC LIMIT ?"
        ),
        params
    )?))
}
pub fn voice_rules(db: &Connection) -> Result<Value> {
    Ok(json!(queries::rows(
        db,
        "SELECT rule_id AS ruleId,scope_tool AS scopeTool,scope_event AS scopeEvent,action,template,priority FROM voice_rules ORDER BY rowid",
        vec![]
    )?))
}
pub fn set_voice_rule(db: &Connection, body: &Value) -> Result<Value> {
    let scope = body
        .get("scopeTool")
        .map(|v| {
            v.as_str()
                .ok_or_else(|| ControlError::invalid("工具范围无效"))
        })
        .transpose()?;
    let event = string(body, "scopeEvent")?;
    let action = string(body, "action")?;
    if event.is_empty() || event.len() > 200 || !["mute", "notify", "speak"].contains(&action) {
        return Err(ControlError::invalid("播报规则无效"));
    }
    let template = body
        .get("template")
        .map(|v| {
            v.as_str()
                .ok_or_else(|| ControlError::invalid("播报模板无效"))
        })
        .transpose()?;
    let priority = body
        .get("priority")
        .map(|v| {
            v.as_str()
                .filter(|p| ["low", "mid", "high"].contains(p))
                .ok_or_else(|| ControlError::invalid("播报优先级无效"))
        })
        .transpose()?;
    let id = format!("{}|{event}", scope.unwrap_or("*"));
    db.execute("INSERT INTO voice_rules(rule_id,scope_tool,scope_event,action,template,priority,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(rule_id) DO UPDATE SET action=excluded.action,template=CASE WHEN ?8 THEN excluded.template ELSE voice_rules.template END,priority=CASE WHEN ?9 THEN excluded.priority ELSE voice_rules.priority END,updated_at=excluded.updated_at",params![id,scope,event,action,template,priority,queries::now(),body.get("template").is_some(),body.get("priority").is_some()])?;
    Ok(queries::rows(db,"SELECT rule_id AS ruleId,scope_tool AS scopeTool,scope_event AS scopeEvent,action,template,priority FROM voice_rules WHERE rule_id=?",vec![Sql::Text(id)])?.remove(0))
}
impl Runtime {
    pub fn mark_task(&self, id: &str, body: &Value) -> Result<Value> {
        if id.is_empty() {
            return Err(ControlError::invalid("缺少会话编号"));
        }
        let kind = string(body, "event")?;
        if ![
            "human.responded",
            "task.retried",
            "task.archived",
            "task.cancelled",
        ]
        .contains(&kind)
        {
            return Err(ControlError::invalid("不支持的任务标记操作"));
        }
        let reason = body
            .get("reason")
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| ControlError::invalid("原因须为字符串"))
            })
            .transpose()?;
        let mut payload = serde_json::Map::new();
        if let Some(s) = reason {
            payload.insert("reason".into(), json!(s));
        }
        let audit = self.config()["privacy"]["auditLog"] == true;
        let (event, result) = {
            let mut db = self.db.lock().map_err(|_| ControlError::unavailable())?;
            let session = queries::rows(
                &db,
                "SELECT tool_id AS toolId,current_state AS state,ended_at AS endedAt FROM sessions WHERE session_id=?",
                vec![Sql::Text(id.into())],
            )?
            .into_iter()
            .next()
            .ok_or_else(|| ControlError::missing("会话不存在"))?;
            let previous: TaskState = session["state"]
                .as_str()
                .unwrap_or_default()
                .parse()
                .map_err(|_| ControlError::unavailable())?;
            let event_type: EventType = kind
                .parse()
                .map_err(|_| ControlError::invalid("事件类型无效"))?;
            if resolve_transition(previous, event_type).is_none() {
                return Err(ControlError {
                    status: 409,
                    code: "ILLEGAL_TRANSITION",
                    message: format!("当前状态 {} 不接受 {kind}", previous.as_str()),
                });
            }
            if kind == "task.archived" {
                payload.insert("previousEndedAt".into(), session["endedAt"].clone());
            }
            let event = Event {
                event_id: format!("evt_{}", uuid::Uuid::new_v4()),
                session_id: id.into(),
                tool_id: session["toolId"].as_str().unwrap_or_default().into(),
                event_type: kind.into(),
                occurred_at: queries::now(),
                actor: "mcp".into(),
                payload,
                schema_version: 1,
            };
            let result = ingest_batch(&mut db, std::slice::from_ref(&event), None, audit)
                .map_err(|_| ControlError::unavailable())?
                .into_iter()
                .next()
                .ok_or_else(ControlError::unavailable)?;
            (event, result)
        };
        let result = json!({"sessionId":id,"eventId":event.event_id,"prevState":result.previous.as_str(),"nextState":result.next.as_str(),"eventType":kind,"ts":event.occurred_at});
        self.emit("state.transition", result.clone());
        self.emit("board.updated", json!({}));
        Ok(result)
    }
    /// Revert the latest manual task mark only if no later event has changed that session.
    /// Keep both entries in the timeline; undo is a compensating state transition.
    pub fn undo_task_mark(&self, id: &str, body: &Value) -> Result<Value> {
        let requested = string(body, "eventId")?;
        let mut db = self.db.lock().map_err(|_| ControlError::unavailable())?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ControlError::unavailable())?;
        let latest: Option<(String, String, String, String, String, String)> = tx
            .query_row(
                "SELECT event_id,event_type,actor,coalesce(prev_state,''),coalesce(next_state,''),coalesce(payload,'{}') FROM state_events WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()
            .map_err(|_| ControlError::unavailable())?;
        let Some((event_id, event_type, actor, previous, next, payload)) = latest else {
            return Err(ControlError::invalid("没有可撤回的最近操作"));
        };
        if event_id != requested
            || actor != "mcp"
            || !["human.responded", "task.retried", "task.archived"].contains(&event_type.as_str())
        {
            return Err(ControlError {
                status: 409,
                code: "UNDO_CONFLICT",
                message: "这条操作已不是最新状态，不能撤回".into(),
            });
        }
        let previous_state: TaskState =
            previous.parse().map_err(|_| ControlError::unavailable())?;
        let next_state: TaskState = next.parse().map_err(|_| ControlError::unavailable())?;
        let current: Option<String> = tx
            .query_row(
                "SELECT current_state FROM sessions WHERE session_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| ControlError::unavailable())?;
        if current.as_deref() != Some(next_state.as_str()) {
            return Err(ControlError {
                status: 409,
                code: "UNDO_CONFLICT",
                message: "任务状态已变化，不能撤回这条旧操作".into(),
            });
        }
        let prior_payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        let ended_at = if previous_state.is_terminal_like() {
            prior_payload.get("previousEndedAt").and_then(Value::as_str)
        } else {
            None
        };
        let occurred_at = queries::now();
        let undo_id = format!("evt_{}", uuid::Uuid::new_v4());
        tx.execute(
            "UPDATE sessions SET current_state=?1,ended_at=?2,updated_at=?3 WHERE session_id=?4 AND current_state=?5",
            params![previous_state.as_str(), ended_at, occurred_at, id, next_state.as_str()],
        )
        .map_err(|_| ControlError::unavailable())?;
        tx.execute(
            "INSERT INTO state_events(event_id,session_id,tool_id,event_type,prev_state,next_state,actor,reason,ts,payload) VALUES(?1,?2,(SELECT tool_id FROM sessions WHERE session_id=?2),'task.action_undone',?3,?4,'human','用户主动撤回',?5,?6)",
            params![undo_id, id, next_state.as_str(), previous_state.as_str(), occurred_at, json!({"undoneEventId":event_id}).to_string()],
        )
        .map_err(|_| ControlError::unavailable())?;
        tx.commit().map_err(|_| ControlError::unavailable())?;
        let result = json!({"sessionId":id,"eventId":undo_id,"undoneEventId":event_id,"prevState":next_state.as_str(),"nextState":previous_state.as_str(),"eventType":"task.action_undone","ts":occurred_at});
        self.emit("state.transition", result.clone());
        self.emit("board.updated", json!({}));
        Ok(result)
    }
    pub fn set_ignored(&self, id: &str, ignored: bool) -> Result<Value> {
        let mut current = self
            .settings
            .lock()
            .map_err(|_| ControlError::unavailable())?;
        let custom = current["scan"]["customTools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| tool["id"] == id));
        if !custom && !self.manifests.iter().any(|m| m["id"] == id) {
            return Err(ControlError::missing("工具不存在"));
        }
        let mut ids = current["scan"]["ignoredToolIds"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        ids.retain(|v| v != id);
        if ignored {
            ids.push(json!(id));
        }
        let next = crate::settings::merge(&current, &json!({"scan":{"ignoredToolIds":ids}}))
            .map_err(|e| ControlError::invalid(e.to_string()))?;
        crate::settings::write_atomic(&self.config_dir.join("settings.json"), &next)
            .map_err(|_| ControlError::unavailable())?;
        *current = next;
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        drop(current);
        self.history
            .lock()
            .map_err(|_| ControlError::unavailable())?
            .retain(|v| v["toolId"] != id);
        if let Some(monitor) = self.monitor.get().and_then(std::sync::Weak::upgrade) {
            monitor.reconfigure();
        }
        if let Some(voice) = self.voice.get().and_then(std::sync::Weak::upgrade) {
            voice.reconfigure();
        }
        self.emit("settings.changed", json!({}));
        self.emit("tools.updated", json!({}));
        Ok(json!({"toolId":id,"ignored":ignored}))
    }
}
