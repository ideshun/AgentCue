use crate::{
    control::{ControlError, Result},
    queries,
    state::Runtime,
};
use agentcue_adapters::{digest, digest_json, hooks::Envelope};
use agentcue_store::engine::{Event, Transition, ingest_events};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params, types::Value as Sql};
use serde_json::{Value, json};
struct Effects<'a, 'db> {
    tx: &'a Transaction<'db>,
    original: Event,
    audit: bool,
    committed: Vec<(Transition, Event, bool)>,
}
impl Effects<'_, '_> {
    fn apply(&mut self, event: Event, announce: bool) -> Result<bool> {
        let transitions = ingest_events(self.tx, std::slice::from_ref(&event), self.audit)
            .map_err(|_| ControlError::unavailable())?;
        let accepted = !transitions.is_empty();
        for transition in transitions {
            self.committed.push((transition, event.clone(), announce));
        }
        Ok(accepted)
    }
    fn synthetic(&mut self, kind: &str, id: &str, reason: &str, title: Option<&str>) -> Result<()> {
        let mut event = self.original.clone();
        event.event_id = format!(
            "evt_hook_synthetic_{}",
            digest_json(&json!([event.event_id, kind, id]))
        );
        event.session_id = id.into();
        event.event_type = kind.into();
        event.actor = "system".into();
        event.payload.clear();
        event.payload.insert("reason".into(), json!(reason));
        if let Some(title) = title.filter(|s| !s.trim().is_empty()) {
            event.payload.insert("taskTitle".into(), json!(title));
        }
        self.apply(event, false)?;
        Ok(())
    }
}
fn source_sessions(
    tx: &Transaction<'_>,
    base: &str,
    before: Option<&str>,
    states: &[&str],
) -> Result<Vec<Value>> {
    let prefix = format!("{base}:turn:");
    let mut values = vec![Sql::Text(base.into()), Sql::Text(prefix)];
    let mut where_clause = "(session_id=?1 OR substr(session_id,1,length(?2))=?2)".to_owned();
    if let Some(time) = before {
        where_clause.push_str(" AND julianday(started_at)<=julianday(?)");
        values.push(Sql::Text(time.into()));
    }
    if !states.is_empty() {
        where_clause.push_str(&format!(
            " AND current_state IN ({})",
            vec!["?"; states.len()].join(",")
        ));
        values.extend(states.iter().map(|s| Sql::Text((*s).into())));
    }
    Ok(queries::rows(
        tx,
        &format!(
            "SELECT session_id AS sessionId,title,current_state AS state,started_at AS startedAt,updated_at AS updatedAt FROM sessions WHERE {where_clause} ORDER BY julianday(started_at) DESC,julianday(updated_at) DESC,session_id DESC"
        ),
        values,
    )?)
}
fn session(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    Ok(queries::rows(
        tx,
        "SELECT current_state AS state,title FROM sessions WHERE session_id=?",
        vec![Sql::Text(id.into())],
    )?
    .into_iter()
    .next())
}
pub async fn consume(runtime: &Runtime, envelope: Envelope) -> Result<Value> {
    let Envelope {
        mut event,
        mode,
        reopen_on_start,
    } = envelope;
    event.occurred_at = chrono::DateTime::parse_from_rfc3339(&event.occurred_at)
        .map_err(|_| ControlError::invalid("事件时间无效"))?
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let base = event.session_id.clone();
    let fallback = if mode == "turn" {
        base.clone()
    } else {
        format!("{base}:turn:{}", &digest(&event.event_id)[..24])
    };
    let (result, effects) = {
        let settings = runtime
            .settings
            .lock()
            .map_err(|_| ControlError::unavailable())?;
        if settings["privacy"]["sessionFileRead"] != true
            || settings["scan"]["ignoredToolIds"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == &event.tool_id))
        {
            return Ok(json!({"accepted":false,"reason":"disabled"}));
        }
        let mut db = runtime.db.lock().map_err(|_| ControlError::unavailable())?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM source_receipts WHERE event_id=?1 UNION ALL SELECT 1 FROM state_events WHERE event_id=?1)",[&event.event_id],|r|r.get(0))?;
        if duplicate {
            let id: Option<String> = tx
                .query_row(
                    "SELECT session_id FROM state_events WHERE event_id=?",
                    [&event.event_id],
                    |r| r.get(0),
                )
                .optional()?;
            return Ok(json!({"accepted":false,"sessionId":id.unwrap_or(fallback)}));
        }
        tx.execute(
            "UPDATE tools SET detect_status='running',last_seen_at=?1 WHERE tool_id=?2",
            params![queries::now(), event.tool_id],
        )?;
        let mut id = fallback;
        let mut recovered = false;
        let mut effects = Effects {
            tx: &tx,
            original: event.clone(),
            audit: settings["privacy"]["auditLog"] == true,
            committed: vec![],
        };
        if mode == "session"
            && event.event_type != "task.started"
            && let Some(last) = source_sessions(&tx, &base, Some(&event.occurred_at), &[])?.first()
        {
            id = last["sessionId"].as_str().unwrap_or_default().into();
        }
        if mode == "session" && event.event_type == "task.started" {
            for candidate in source_sessions(
                &tx,
                &base,
                None,
                &["completed", "cancelled", "failed", "timeout"],
            )?
            .into_iter()
            .rev()
            {
                let started = candidate["startedAt"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
                if started.is_none_or(|t| {
                    t < chrono::DateTime::parse_from_rfc3339(&event.occurred_at).unwrap()
                }) {
                    continue;
                }
                let candidate_id = candidate["sessionId"].as_str().unwrap_or_default();
                let missing:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM state_events WHERE session_id=?1 AND event_type='task.started' AND actor='system' AND reason='hook-missing-start')",[candidate_id],|r|r.get(0))?;
                if !missing {
                    continue;
                }
                let matched:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM state_events WHERE session_id=?1 AND actor='tool' AND (event_type='task.started' OR (event_type='anomaly' AND reason='out-of-order' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.originalEventType') ELSE 'task.started' END='task.started')))",[candidate_id],|r|r.get(0))?;
                if !matched {
                    id = candidate_id.into();
                    recovered = true;
                    break;
                }
            }
        }
        if mode == "session" && event.event_type == "task.started" && !recovered {
            for previous in source_sessions(
                &tx,
                &base,
                Some(&event.occurred_at),
                &["running", "waiting_human"],
            )? {
                let previous_id = previous["sessionId"].as_str().unwrap_or_default();
                if previous_id != id
                    && previous["updatedAt"]
                        .as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .is_some_and(|t| {
                            t <= chrono::DateTime::parse_from_rfc3339(&event.occurred_at).unwrap()
                        })
                {
                    effects.synthetic(
                        "task.cancelled",
                        previous_id,
                        "hook-next-turn",
                        previous["title"].as_str(),
                    )?;
                }
            }
        }
        let current = session(&tx, &id)?;
        if reopen_on_start
            && event.event_type == "task.started"
            && current.as_ref().is_some_and(|v| {
                ["completed", "cancelled", "failed", "timeout"]
                    .iter()
                    .any(|s| v["state"] == *s)
            })
        {
            effects.synthetic(
                "task.archived",
                &id,
                "hook-turn-reopen",
                current.as_ref().and_then(|v| v["title"].as_str()),
            )?;
        }
        if event.event_type != "task.started"
            && current.as_ref().is_none_or(|v| v["state"] == "idle")
        {
            effects.synthetic(
                "task.started",
                &id,
                "hook-missing-start",
                event.payload.get("taskTitle").and_then(Value::as_str),
            )?;
        }
        if current
            .as_ref()
            .is_some_and(|v| v["state"] == "waiting_human")
            && ["task.completed", "task.failed"].contains(&event.event_type.as_str())
        {
            effects.synthetic(
                "human.responded",
                &id,
                "hook-terminal-resumed",
                current.as_ref().and_then(|v| v["title"].as_str()),
            )?;
        }
        let mut actual = event.clone();
        actual.session_id = id.clone();
        if recovered {
            actual.event_type = "anomaly".into();
            actual
                .payload
                .insert("reason".into(), json!("out-of-order"));
            actual
                .payload
                .insert("originalEventType".into(), json!("task.started"));
        }
        let accepted = effects.apply(actual, true)?;
        if let Some(title) = event
            .payload
            .get("taskTitle")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            tx.execute(
                "UPDATE sessions SET title=?1 WHERE session_id=?2",
                params![title, id],
            )?;
        }
        let committed = effects.committed;
        tx.commit()?;
        (json!({"accepted":accepted,"sessionId":id}), committed)
    };
    for (transition, event, announce) in effects {
        runtime.emit("state.transition",json!({"sessionId":transition.session_id,"prevState":transition.previous.as_str(),"nextState":transition.next.as_str(),"eventType":event.event_type,"ts":event.occurred_at}));
        if announce {
            runtime
                .notices
                .send(event)
                .await
                .map_err(|_| ControlError::unavailable())?;
        }
    }
    runtime.emit("tools.updated", json!({}));
    runtime.emit("board.updated", json!({}));
    Ok(result)
}
