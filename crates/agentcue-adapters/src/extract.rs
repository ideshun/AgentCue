use crate::{digest_json, text};
use agentcue_store::engine::Event;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speech_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_speech_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded: Option<bool>,
}
pub struct Context<'a> {
    pub tool_id: &'a str,
    pub project: &'a str,
    pub session_key: &'a str,
    pub source_path: Option<&'a str>,
    pub title: Option<&'a str>,
    pub context: SourceContext,
}
#[derive(Serialize)]
pub struct Batch {
    pub events: Vec<Event>,
    pub context: SourceContext,
    pub titles: Vec<Title>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Title {
    pub session_id: String,
    pub title: Option<String>,
}
fn internal_source(rows: &[Value]) -> Option<bool> {
    let metadata = rows.iter().find(|r| r["type"] == "session_meta")?;
    let Some(source) = metadata["payload"]["source"].as_object() else {
        return Some(false);
    };
    if source.len() != 1 {
        return Some(false);
    }
    let (key, kind) = source.iter().next().unwrap();
    if key == "internal" {
        return Some(kind.is_string());
    }
    if key != "subagent" {
        return Some(false);
    }
    if kind.is_string() {
        return Some(true);
    }
    let Some(variants) = kind.as_object().filter(|o| o.len() == 1) else {
        return Some(false);
    };
    let (variant, value) = variants.iter().next().unwrap();
    Some(
        (variant == "thread_spawn" && (value.is_object() || value.is_array()))
            || (variant == "other" && value.is_string()),
    )
}
fn matches(row: &Value, rule: &Value, turn: bool) -> bool {
    let kind = row["payload"]["type"].as_str();
    let matched = rule["match"].as_str().unwrap_or_default();
    let alias = turn
        && ((matched == "task_started" && kind == Some("turn_started"))
            || (matched == "task_complete" && kind == Some("turn_complete")));
    if row["type"] != matched && row["toolName"] != matched && kind != Some(matched) && !alias {
        return false;
    }
    let Some(ok) = rule["ok"].as_bool() else {
        return true;
    };
    let error = row["is_error"] == true
        || row["payload"]
            .get("error")
            .is_some_and(|v| !v.is_null() && v != false && v != "");
    if ok { !error } else { error }
}
fn encounter(
    titles: &mut Vec<Title>,
    speech: &mut HashMap<String, String>,
    id: &str,
    title: Option<&str>,
    spoken: Option<&str>,
) {
    if !titles.iter().any(|v| v.session_id == id) {
        titles.push(Title {
            session_id: id.into(),
            title: title.map(str::to_owned),
        });
    }
    if let Some(spoken) = spoken.filter(|s| !s.is_empty()) {
        speech.entry(id.into()).or_insert_with(|| spoken.into());
    }
}
fn iso(row: &Value) -> String {
    row["timestamp"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&chrono::Utc))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn extract(rows: &[Value], manifest: &Value, ctx: Context<'_>) -> Batch {
    let base = format!("{}:{}:{}", ctx.tool_id, ctx.project, ctx.session_key);
    let by_turn = manifest["sessionSource"]["identityMode"] == "turn";
    let mut context = ctx.context;
    if by_turn && context.excluded.is_none() {
        context.excluded = internal_source(rows);
    }
    if context.excluded == Some(true) {
        return Batch {
            events: vec![],
            context: SourceContext {
                excluded: Some(true),
                ..Default::default()
            },
            titles: vec![],
        };
    }
    let mut events = vec![];
    let mut titles = vec![];
    let mut speech = HashMap::new();
    let id_for = |task: Option<&str>| {
        task.map(|id| format!("{base}:turn:{id}"))
            .unwrap_or_else(|| base.clone())
    };
    for row in rows {
        let kind = row["payload"]["type"].as_str();
        let boundary = by_turn
            && row["type"] == "event_msg"
            && kind.is_some_and(|s| {
                [
                    "task_started",
                    "turn_started",
                    "task_complete",
                    "turn_complete",
                    "turn_aborted",
                ]
                .contains(&s)
            });
        let task = if boundary {
            row["payload"]["turn_id"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
        } else {
            None
        };
        let starts = boundary && kind.is_some_and(|s| s == "task_started" || s == "turn_started");
        if task.is_some() && starts && task != context.task_id.as_deref() {
            context = SourceContext {
                excluded: context.excluded,
                task_id: task.map(str::to_owned),
                title: context.pending_title.take(),
                speech_title: context.pending_speech_title.take(),
                closed: Some(false),
                ..Default::default()
            };
        } else if boundary && task.is_none() && context.task_id.is_none() && starts {
            context.closed = Some(false);
            context.pending_title = None;
            context.pending_speech_title = None;
        }
        if let Some((title, spoken)) = text::user_titles(row) {
            if by_turn && context.closed == Some(true) {
                if context.pending_title.is_none() {
                    context.pending_title = Some(title);
                    context.pending_speech_title = spoken;
                }
            } else if by_turn && context.task_id.is_none() {
                if context.title.is_none() {
                    context.title = Some(title.clone());
                    context.speech_title = spoken.clone();
                }
                if context.pending_title.is_none() {
                    context.pending_title = Some(title);
                    context.pending_speech_title = spoken;
                }
                encounter(
                    &mut titles,
                    &mut speech,
                    &base,
                    context.title.as_deref(),
                    context.speech_title.as_deref(),
                );
            } else {
                if context.title.is_none() {
                    context.title = Some(title.clone());
                    context.speech_title = spoken;
                }
                let id = if by_turn {
                    id_for(context.task_id.as_deref())
                } else {
                    base.clone()
                };
                encounter(
                    &mut titles,
                    &mut speech,
                    &id,
                    context.title.as_deref().or(Some(&title)),
                    context.speech_title.as_deref(),
                );
                if let Some(v) = titles
                    .iter_mut()
                    .find(|v| v.session_id == id && v.title.is_none())
                {
                    v.title = context.title.clone().or(Some(title));
                }
            }
        }
        if let Some(mapping) = manifest["eventMapping"].as_object() {
            for (semantic, rule) in mapping {
                let event_type = match semantic.as_str() {
                    "started" => "task.started",
                    "waiting_human" => "task.waiting_human",
                    "completed" => "task.completed",
                    "failed" => "task.failed",
                    "cancelled" => "task.cancelled",
                    _ => continue,
                };
                if !matches(row, rule, by_turn) {
                    continue;
                }
                let task = if by_turn { task } else { None };
                let id = id_for(task);
                let title = if let Some(task) = task {
                    if context.task_id.as_deref() == Some(task) {
                        context.title.as_deref()
                    } else {
                        None
                    }
                } else {
                    ctx.title.or_else(|| {
                        if context.task_id.is_none() {
                            context.title.as_deref()
                        } else {
                            None
                        }
                    })
                };
                let spoken = if task.map_or(context.task_id.is_none(), |t| {
                    context.task_id.as_deref() == Some(t)
                }) {
                    context.speech_title.as_deref()
                } else {
                    None
                };
                encounter(&mut titles, &mut speech, &id, title, spoken);
                let source = format!("{}:{id}", ctx.source_path.unwrap_or_default());
                let event_id = format!("evt_{}", digest_json(&json!([source, event_type, row])));
                let mut payload = serde_json::Map::new();
                if let Some(reason) = rule.get("reason") {
                    payload.insert("reason".into(), reason.clone());
                }
                events.push(Event {
                    event_id,
                    session_id: id,
                    tool_id: ctx.tool_id.into(),
                    event_type: event_type.into(),
                    occurred_at: iso(row),
                    actor: "tool".into(),
                    payload,
                    schema_version: 1,
                });
            }
        }
        if task.is_some() && boundary && !starts && task == context.task_id.as_deref() {
            context.closed = Some(true);
        } else if boundary && task.is_none() && context.task_id.is_none() && !starts {
            context.closed = Some(true);
            context.pending_title = None;
            context.pending_speech_title = None;
        }
    }
    for event in &mut events {
        if let Some(title) = titles
            .iter()
            .find(|v| v.session_id == event.session_id)
            .and_then(|v| v.title.as_ref())
        {
            event.payload.insert("taskTitle".into(), json!(title));
        }
        if let Some(spoken) = speech.get(&event.session_id) {
            event
                .payload
                .insert("taskSpeechTitle".into(), json!(spoken));
        }
    }
    Batch {
        events,
        context,
        titles,
    }
}
