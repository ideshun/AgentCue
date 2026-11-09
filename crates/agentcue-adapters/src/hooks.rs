//! Minimal payloads derived from the already-verified official hook contracts.
use crate::{digest, digest_json, text};
use agentcue_store::engine::Event;
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Hook 缺少有效的 {key}"))
}
fn timestamp(value: &str) -> Result<(), String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$").unwrap()
    });
    if !RE.is_match(value) || chrono::DateTime::parse_from_rfc3339(value).is_err() {
        return Err("Hook 时间无效".into());
    }
    Ok(())
}
fn phase<'a>(value: &'a Value, explicit: Option<&'a str>) -> Result<&'a str, String> {
    let native = value
        .get("hook_event_name")
        .map(|v| v.as_str().ok_or("Hook 阶段须为字符串"))
        .transpose()?;
    if explicit.is_some() && native.is_some() && explicit != native {
        return Err("Hook 显式阶段与原生阶段不一致".into());
    }
    explicit.or(native).ok_or_else(|| "Hook 缺少阶段".into())
}
fn encode_uri(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c >= ' ' && *c != '\u{7f}')
        .map(|c| {
            if c == ':' || c.is_whitespace() {
                '_'
            } else {
                c
            }
        })
        .take(128)
        .collect()
}
fn transcript(value: &Value) -> Option<(String, String)> {
    let raw = value.as_str()?.trim();
    if raw.is_empty() || raw.ends_with(['\\', '/']) {
        return None;
    }
    let parts: Vec<_> = raw.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    let file = parts[parts.len() - 1];
    let stem = file
        .rfind('.')
        .filter(|n| *n > 0)
        .map(|p| &file[..p])
        .unwrap_or(file);
    let project = sanitize(parts[parts.len() - 2]);
    let key = sanitize(stem);
    (!project.is_empty() && !key.is_empty()).then_some((project, key))
}
fn title(value: &Value) -> Result<Option<(String, Option<String>)>, String> {
    let prompt = value["prompt"]
        .as_str()
        .ok_or("Hook 的 prompt 须为字符串")?;
    Ok(text::user_titles(
        &json!({"type":"user","message":{"role":"user","content":prompt}}),
    ))
}
fn event(
    tool: &str,
    kind: &str,
    session: String,
    identity: Value,
    time: &str,
    titles: Option<(String, Option<String>)>,
) -> Event {
    let mut payload = serde_json::Map::new();
    if let Some((title, speech)) = titles {
        payload.insert("taskTitle".into(), json!(title));
        if let Some(s) = speech {
            payload.insert("taskSpeechTitle".into(), json!(s));
        }
    }
    Event {
        event_id: format!("evt_hook_{}", digest_json(&identity)),
        session_id: session,
        tool_id: tool.into(),
        event_type: kind.into(),
        occurred_at: time.into(),
        actor: "tool".into(),
        payload,
        schema_version: 1,
    }
}
pub fn normalize(
    tool: &str,
    value: &Value,
    explicit: Option<&str>,
    received: &str,
) -> Result<Vec<Event>, String> {
    if !value.is_object() {
        return Err("Hook 输入须为 JSON 对象".into());
    }
    match tool {
        "cursor" => {
            let phase = phase(value, explicit)?;
            if !["beforeSubmitPrompt", "preToolUse", "stop"].contains(&phase) {
                return Ok(vec![]);
            }
            let conversation = required(value, "conversation_id")?;
            let generation = required(value, "generation_id")?;
            let (kind, titles, part) = match phase {
                "beforeSubmitPrompt" => ("task.started", title(value)?, "started"),
                "preToolUse" => {
                    let Some(name) = value["tool_name"].as_str() else {
                        return Ok(vec![]);
                    };
                    if !["askquestion", "ask_question_tool_call"]
                        .contains(&name.trim().to_lowercase().as_str())
                    {
                        return Ok(vec![]);
                    }
                    ("task.waiting_human", None, "waiting")
                }
                _ => {
                    let kind = match value["status"].as_str() {
                        Some("completed") => "task.completed",
                        Some("aborted") => "task.cancelled",
                        Some("error") => "task.failed",
                        _ => return Err("Cursor stop.status 无效".into()),
                    };
                    (kind, None, "terminal")
                }
            };
            timestamp(received)?;
            Ok(vec![event(
                tool,
                kind,
                format!(
                    "cursor:hooks:{}:turn:{}",
                    encode_uri(conversation),
                    encode_uri(generation)
                ),
                json!(["cursor-hooks-v1", conversation, generation, part]),
                received,
                titles,
            )])
        }
        "cline" => {
            let phase = required(value, "hookName")?;
            if explicit.is_some_and(|p| p != phase) {
                return Err("Cline 显式阶段与原生阶段不一致".into());
            }
            let task = required(value, "taskId")?;
            let stamp = required(value, "timestamp")?;
            if stamp.is_empty()
                || !stamp.bytes().all(|b| b.is_ascii_digit())
                || (stamp.len() > 1 && stamp.starts_with('0'))
            {
                return Err("Cline timestamp 须为毫秒整数字符串".into());
            }
            let milliseconds = stamp
                .parse::<i64>()
                .ok()
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or("Cline timestamp 超出有效范围")?;
            let occurred = chrono::DateTime::from_timestamp_millis(milliseconds)
                .ok_or("Cline timestamp 超出有效范围")?
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            if !["TaskStart", "TaskComplete", "TaskCancel"].contains(&phase) {
                return Ok(vec![]);
            }
            let kind = match phase {
                "TaskStart" => "task.started",
                "TaskComplete" => "task.completed",
                _ => "task.cancelled",
            };
            let titles = if phase == "TaskStart" {
                let initial = value["taskStart"]["taskMetadata"]["initialTask"]
                    .as_str()
                    .ok_or("Cline initialTask 须为字符串")?;
                text::user_titles(
                    &json!({"type":"user","message":{"role":"user","content":initial}}),
                )
            } else {
                None
            };
            timestamp(received)?;
            Ok(vec![event(
                tool,
                kind,
                format!("cline:hooks:{}", digest(task)),
                json!(["cline-hooks-v1", task, phase, stamp]),
                &occurred,
                titles,
            )])
        }
        "codebuddy" => {
            let phase = phase(value, explicit)?;
            if !["UserPromptSubmit", "Stop"].contains(&phase) {
                return Ok(vec![]);
            }
            let session = required(value, "session_id")?;
            let generation = value["generation_id"]
                .as_str()
                .filter(|s| !s.trim().is_empty());
            let titles = if phase == "UserPromptSubmit" {
                title(value)?
            } else {
                None
            };
            let base = format!("codebuddy:hooks:{}", digest(session));
            let (id, identity) = if let Some(generation) = generation {
                (
                    format!("{base}:turn:{}", digest(generation)),
                    json!(["codebuddy-ide-hooks-v2", session, generation, phase]),
                )
            } else {
                (
                    base,
                    json!(["codebuddy-ide-hooks-v1", session, phase, received]),
                )
            };
            timestamp(received)?;
            Ok(vec![event(
                tool,
                if phase == "UserPromptSubmit" {
                    "task.started"
                } else {
                    "task.completed"
                },
                id,
                identity,
                received,
                titles,
            )])
        }
        "claude-code" => {
            let phase = phase(value, explicit)?;
            if !["UserPromptSubmit", "Stop", "Notification"].contains(&phase) {
                return Ok(vec![]);
            }
            let native = required(value, "session_id")?;
            let (kind, titles) = match phase {
                "UserPromptSubmit" => ("task.started", title(value)?),
                "Stop" => ("task.completed", None),
                _ => {
                    if value["notification_type"] != "permission_prompt" {
                        return Ok(vec![]);
                    }
                    ("task.waiting_human", None)
                }
            };
            timestamp(received)?;
            let parts = transcript(&value["transcript_path"]);
            let session = parts
                .as_ref()
                .map(|(p, k)| format!("claude-code:{p}:{k}"))
                .unwrap_or_else(|| format!("claude-code:hooks:{}", digest(native)));
            let key = parts.as_ref().map(|(_, k)| k.as_str()).unwrap_or(&session);
            let prompt = value["prompt_id"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(received);
            Ok(vec![event(
                tool,
                kind,
                session.clone(),
                json!(["claude-code-hooks-v1", key, prompt, phase]),
                received,
                titles,
            )])
        }
        _ => Err("工具不支持任务 Hooks".into()),
    }
}
pub struct Envelope {
    pub event: Event,
    pub mode: &'static str,
    pub reopen_on_start: bool,
}
pub fn parse(value: &Value) -> Result<Envelope, String> {
    let mut e: Event =
        serde_json::from_value(value["event"].clone()).map_err(|_| "任务 Hook 事件格式无效")?;
    timestamp(&e.occurred_at)?;
    let explicit_turn = e.session_id.contains(":turn:");
    let (mode, allowed) = match e.tool_id.as_str() {
        "claude-code" => (
            "turn",
            vec!["task.started", "task.completed", "task.waiting_human"],
        ),
        "cursor" => (
            "turn",
            vec![
                "task.started",
                "task.completed",
                "task.cancelled",
                "task.failed",
                "task.waiting_human",
            ],
        ),
        "cline" => (
            "session",
            vec!["task.started", "task.completed", "task.cancelled"],
        ),
        "codebuddy" => (
            if explicit_turn { "turn" } else { "session" },
            vec!["task.started", "task.completed"],
        ),
        _ => return Err("工具不支持任务 Hooks".into()),
    };
    let claude = e.tool_id == "claude-code";
    let identity = if claude {
        let parts: Vec<_> = e
            .session_id
            .strip_prefix("claude-code:")
            .unwrap_or_default()
            .split(':')
            .collect();
        (parts.len() == 2 && parts[0] == "hooks" && hex64(parts[1]))
            || ((parts.len() == 2
                || (parts.len() == 4
                    && parts[2] == "turn"
                    && !parts[3].is_empty()
                    && parts[3].chars().count() <= 256))
                && parts[0] != "hooks"
                && parts[..2]
                    .iter()
                    .all(|s| !s.is_empty() && s.chars().count() <= 128)
                && !e.session_id.chars().any(char::is_whitespace))
    } else {
        e.session_id.starts_with(&format!("{}:hooks:", e.tool_id))
    };
    if value["mode"] != mode
        || e.actor != "tool"
        || e.schema_version != 1
        || !e.event_id.strip_prefix("evt_hook_").is_some_and(hex64)
        || !identity
        || e.session_id.chars().count() > if claude { 512 } else { 2048 }
        || (!claude && mode == "turn" && !explicit_turn)
        || (mode == "session" && explicit_turn)
        || !allowed.contains(&e.event_type.as_str())
    {
        return Err("任务 Hook 事件无效".into());
    }
    let mut payload = serde_json::Map::new();
    for (key, limit) in [
        ("taskTitle", 40),
        ("taskSpeechTitle", text::SPEECH_TITLE_MAX),
    ] {
        if let Some(value) = e.payload.get(key) {
            let title = value.as_str().ok_or("Hook 标题须为字符串")?.trim();
            if !title.is_empty() {
                let title = if key == "taskSpeechTitle" {
                    text::compact_references(title)
                } else {
                    title.into()
                };
                payload.insert(
                    key.into(),
                    json!(title.chars().take(limit).collect::<String>()),
                );
            }
        }
    }
    e.payload = payload;
    Ok(Envelope {
        event: e,
        mode,
        reopen_on_start: claude,
    })
}
fn hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn acknowledgment(tool: &str, phase: Option<&str>) -> Value {
    match tool {
        "cline" => json!({"cancel":false}),
        "codebuddy" => json!({"continue":true,"suppressOutput":true}),
        "cursor" if phase == Some("beforeSubmitPrompt") => json!({"continue":true}),
        _ => json!({}),
    }
}

/// Task identity granularity declared by the supported native hook adapters.
pub fn mode(event: &Event) -> &'static str {
    if event.tool_id == "claude-code"
        || event.tool_id == "cursor"
        || (event.tool_id == "codebuddy" && event.session_id.contains(":turn:"))
    {
        "turn"
    } else {
        "session"
    }
}
