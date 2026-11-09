//! Transactional source ingestion. No notifications escape before commit succeeds.
use agentcue_core::{EventType, TaskState, resolve_transition};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{error::Error, fmt};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_id: String,
    pub session_id: String,
    pub tool_id: String,
    pub event_type: String,
    pub occurred_at: String,
    pub actor: String,
    #[serde(default)]
    pub payload: Map<String, Value>,
    pub schema_version: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub source_path: String,
    pub tool_id: String,
    pub file_identity: String,
    #[serde(rename = "offset", alias = "byteOffset")]
    pub byte_offset: i64,
    pub prefix_hash: String,
    pub title: Option<String>,
    pub updated_at: String,
    pub context: Option<Value>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Transition {
    pub event_id: String,
    pub session_id: String,
    pub event_type: EventType,
    pub previous: TaskState,
    pub next: TaskState,
}

#[derive(Debug)]
pub enum IngestError {
    Invalid(&'static str),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
}
impl fmt::Display for IngestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => f.write_str(reason),
            Self::Sqlite(e) => write!(f, "{e}"),
            Self::Json(e) => write!(f, "{e}"),
        }
    }
}
impl Error for IngestError {}
impl From<rusqlite::Error> for IngestError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}
impl From<serde_json::Error> for IngestError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

fn timestamp(db: &Connection, value: &str) -> Result<f64, IngestError> {
    if !value.contains('T') || !(value.ends_with('Z') || value.chars().rev().nth(2) == Some(':')) {
        return Err(IngestError::Invalid("invalid event timestamp"));
    }
    db.query_row("SELECT julianday(?1)", [value], |r| {
        r.get::<_, Option<f64>>(0)
    })?
    .ok_or(IngestError::Invalid("invalid event timestamp"))
}
fn validate(db: &Connection, event: &Event) -> Result<EventType, IngestError> {
    if !event.event_id.starts_with("evt_")
        || event.session_id.is_empty()
        || event.tool_id.is_empty()
        || event.schema_version != 1
    {
        return Err(IngestError::Invalid("invalid event identity or schema"));
    }
    if !["tool", "human", "system", "mcp"].contains(&event.actor.as_str()) {
        return Err(IngestError::Invalid("invalid actor"));
    }
    for key in ["taskTitle", "taskSpeechTitle", "reason"] {
        if event.payload.get(key).is_some_and(|v| !v.is_string()) {
            return Err(IngestError::Invalid("invalid event payload"));
        }
    }
    timestamp(db, &event.occurred_at)?;
    event
        .event_type
        .parse()
        .map_err(|_| IngestError::Invalid("unknown event type"))
}

/// Caller registers tools and enforces privacy/ignore settings before invoking this function.
/// All returned transitions are safe to dispatch only after this function returns Ok.
pub fn ingest_batch(
    db: &mut Connection,
    events: &[Event],
    checkpoint: Option<&Checkpoint>,
    audit: bool,
) -> Result<Vec<Transition>, IngestError> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let transitions = ingest_events(&tx, events, audit)?;
    save_checkpoint(&tx, events, checkpoint, false)?;
    tx.commit()?;
    Ok(transitions)
}

/// Apply normalized events inside a caller-owned transaction; dispatch effects only after commit.
pub fn ingest_events(
    tx: &Transaction<'_>,
    events: &[Event],
    audit: bool,
) -> Result<Vec<Transition>, IngestError> {
    let mut transitions = Vec::new();
    for original in events {
        let mut kind = validate(tx, original)?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM source_receipts WHERE event_id=?1 UNION ALL SELECT 1 FROM state_events WHERE event_id=?1)", [&original.event_id], |r| r.get::<_,bool>(0))? { continue; }
        let existing: Option<(String, String, i64, String)> = tx
            .query_row(
                "SELECT current_state,updated_at,visible,tool_id FROM sessions WHERE session_id=?1",
                [&original.session_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((_, _, _, tool)) = &existing
            && tool != &original.tool_id
        {
            return Err(IngestError::Invalid("session belongs to another tool"));
        }
        if existing.as_ref().is_some_and(|row| row.2 == 0) {
            continue;
        }
        let previous = existing
            .as_ref()
            .map(|row| row.0.parse())
            .transpose()
            .map_err(|_| IngestError::Invalid("unknown persisted state"))?
            .unwrap_or(TaskState::Idle);
        let mut payload = original.payload.clone();
        if !kind.is_observation()
            && let Some((_, last, _, _)) = &existing
            && timestamp(tx, &original.occurred_at)? < timestamp(tx, last)?
        {
            payload.insert(
                "originalEventType".into(),
                Value::String(original.event_type.clone()),
            );
            payload.insert("reason".into(), Value::String("out-of-order".into()));
            kind = EventType::Anomaly;
        }
        let next = resolve_transition(previous, kind);
        if next.is_none() && !kind.is_observation() {
            if audit {
                tx.execute("INSERT INTO audit_log(ts,actor,action,target,result) VALUES(?1,?2,'illegal.transition.rejected',?3,?4)",params![original.occurred_at,original.actor,original.session_id,format!("{} does not accept {}",previous.as_str(),kind.as_str())])?;
            }
        } else {
            let title = payload
                .get("taskTitle")
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty());
            let current = next.unwrap_or(previous);
            if next.is_some() {
                let ended = current
                    .is_terminal_like()
                    .then_some(original.occurred_at.as_str());
                let started = (existing.is_none() || previous == TaskState::Idle)
                    .then_some(original.occurred_at.as_str());
                tx.execute("INSERT INTO sessions(session_id,tool_id,title,current_state,started_at,ended_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(session_id) DO UPDATE SET current_state=excluded.current_state,title=coalesce(excluded.title,sessions.title),ended_at=excluded.ended_at,updated_at=excluded.updated_at",params![original.session_id,original.tool_id,title,current.as_str(),started,ended,original.occurred_at])?;
            } else {
                tx.execute("INSERT INTO sessions(session_id,tool_id,current_state,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(session_id) DO NOTHING",params![original.session_id,original.tool_id,previous.as_str(),original.occurred_at])?;
            }
            let encoded = serde_json::to_string(&payload)?;
            tx.execute("INSERT INTO state_events(event_id,session_id,tool_id,event_type,prev_state,next_state,actor,reason,ts,payload) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![original.event_id,original.session_id,original.tool_id,kind.as_str(),previous.as_str(),next.map(TaskState::as_str),original.actor,payload.get("reason").and_then(Value::as_str),original.occurred_at,encoded])?;
            if let Some(next) = next {
                transitions.push(Transition {
                    event_id: original.event_id.clone(),
                    session_id: original.session_id.clone(),
                    event_type: kind,
                    previous,
                    next,
                });
            }
        }
        tx.execute("INSERT INTO source_receipts(event_id,processed_at) VALUES(?1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",[&original.event_id])?;
    }
    Ok(transitions)
}
fn save_checkpoint(
    tx: &Transaction<'_>,
    events: &[Event],
    checkpoint: Option<&Checkpoint>,
    allow_reset: bool,
) -> Result<(), IngestError> {
    if let Some(cp) = checkpoint {
        if cp.source_path.is_empty()
            || cp.tool_id.is_empty()
            || cp.file_identity.is_empty()
            || cp.byte_offset < 0
            || events.iter().any(|e| e.tool_id != cp.tool_id)
        {
            return Err(IngestError::Invalid("invalid source checkpoint"));
        }
        let prior: Option<(String, i64, String)> = tx.query_row(
            "SELECT file_identity,byte_offset,tool_id FROM source_checkpoints WHERE source_path=?1",
            [&cp.source_path], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((identity, offset, tool)) = prior
            && (tool != cp.tool_id
                || (!allow_reset && identity == cp.file_identity && cp.byte_offset < offset))
        {
            return Err(IngestError::Invalid(
                "stale or mismatched source checkpoint",
            ));
        }
        timestamp(tx, &cp.updated_at)?;
        let context = cp.context.as_ref().map(serde_json::to_string).transpose()?;
        tx.execute("INSERT INTO source_checkpoints(source_path,tool_id,file_identity,byte_offset,prefix_hash,title,updated_at,context) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(source_path) DO UPDATE SET tool_id=excluded.tool_id,file_identity=excluded.file_identity,byte_offset=excluded.byte_offset,prefix_hash=excluded.prefix_hash,title=excluded.title,updated_at=excluded.updated_at,context=excluded.context",params![cp.source_path,cp.tool_id,cp.file_identity,cp.byte_offset,cp.prefix_hash,cp.title,cp.updated_at,context])?;
    }
    Ok(())
}

/// Source metadata and offsets commit atomically, with compare-and-swap against the consumed position.
/// This permits verified truncation/replacement while rejecting work computed from an obsolete checkpoint.
pub fn ingest_source_batch(
    db: &mut Connection,
    events: &[Event],
    checkpoint: &Checkpoint,
    previous: Option<&Checkpoint>,
    titles: &[(String, Option<String>)],
    visibility: Option<(&str, bool)>,
    audit: bool,
) -> Result<Vec<Transition>, IngestError> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let actual:Option<(String,i64,String)>=tx.query_row("SELECT file_identity,byte_offset,prefix_hash FROM source_checkpoints WHERE source_path=?1",[&checkpoint.source_path],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let expected = previous.map(|p| {
        (
            p.file_identity.clone(),
            p.byte_offset,
            p.prefix_hash.clone(),
        )
    });
    if actual != expected
        || previous.is_some_and(|p| {
            p.source_path != checkpoint.source_path || p.tool_id != checkpoint.tool_id
        })
    {
        return Err(IngestError::Invalid(
            "source checkpoint changed during capture",
        ));
    }
    if let Some((base, visible)) = visibility {
        let prefix = format!("{base}:turn:");
        tx.execute("UPDATE sessions SET visible=?1 WHERE session_id=?2 OR substr(session_id,1,length(?3))=?3",params![visible,base,prefix])?;
    }
    for (id, title) in titles {
        tx.execute(
            "UPDATE sessions SET title=?1 WHERE session_id=?2",
            params![title, id],
        )?;
    }
    let transitions = ingest_events(&tx, events, audit)?;
    for (id, title) in titles {
        tx.execute(
            "UPDATE sessions SET title=?1 WHERE session_id=?2",
            params![title, id],
        )?;
    }
    save_checkpoint(&tx, events, Some(checkpoint), true)?;
    tx.commit()?;
    Ok(transitions)
}
