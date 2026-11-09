use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::LazyLock;
pub const SPEECH_TITLE_MAX: usize = 60;
pub fn compact_references(text: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(^|[^-A-Za-z0-9._%+])@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s<>"'“”‘’()\[\]{}（）【】,，;；!?！？*]+))"#).unwrap()
    });
    RE.replace_all(text, |c: &Captures| {
        let reference = c
            .get(2)
            .or_else(|| c.get(3))
            .or_else(|| c.get(4))
            .unwrap()
            .as_str();
        if !reference.contains(['\\', '/'])
            || reference.to_lowercase().starts_with("https://")
            || reference.to_lowercase().starts_with("http://")
        {
            return c[0].to_owned();
        }
        let name = reference.split(['\\', '/']).rfind(|s| !s.is_empty());
        match name {
            Some(name) if name != "." && name != ".." => format!("{}{name}", &c[1]),
            _ => c[0].to_owned(),
        }
    })
    .into_owned()
}
fn content(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.into());
    }
    let list = value.as_array()?;
    let parts: Vec<&str> = list
        .iter()
        .filter(|p| p["type"] == "text" || p["type"] == "input_text")
        .filter_map(|p| p["text"].as_str())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}
fn is_control_tag(tag: &str) -> bool {
    [
        "environment_context",
        "permissions",
        "permissions instructions",
        "collaboration_mode",
        "user_instructions",
        "skills_instructions",
        "app-context",
        "multi_agent_mode",
        "multi_agent_role",
        "context_window",
        "context_window_guidance",
        "instructions",
    ]
    .contains(&tag.to_lowercase().as_str())
}
fn control_start(value: &str) -> Option<(&str, usize)> {
    if !value.starts_with('<') {
        return None;
    }
    let close = value.find('>')?;
    let head = &value[1..close];
    // Match the named control prefix, including attributes, exactly as the shipping parser does.
    let tag = [
        "permissions instructions",
        "environment_context",
        "permissions",
        "collaboration_mode",
        "user_instructions",
        "skills_instructions",
        "app-context",
        "multi_agent_mode",
        "multi_agent_role",
        "context_window_guidance",
        "context_window",
        "INSTRUCTIONS",
    ]
    .into_iter()
    .find(|tag| {
        head.get(..tag.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(tag))
            && head.get(tag.len()..).is_some_and(|s| {
                s.is_empty() || s.starts_with(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            })
    })?;
    Some((&head[..tag.len()], close + 1))
}
fn clean(text: &str) -> Option<String> {
    static AGENTS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^#{1,6}\s+AGENTS\.md instructions\b").unwrap());
    static REQUEST: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^#{1,3}\s+My request(?: for Codex)?:[ \t]*(.*)$").unwrap()
    });
    static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(`{3,}|~{3,})").unwrap());
    let mut value = text.trim().to_owned();
    let control = AGENTS.is_match(&value) || control_start(&value).is_some();
    let lines: Vec<&str> = value.lines().collect();
    let mut fence: Option<String> = None;
    let mut replacement = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(marker) = FENCE.captures(line) {
            let marker = &marker[1];
            if fence.is_none() {
                fence = Some(marker.into());
            } else if fence
                .as_ref()
                .is_some_and(|s| s.as_bytes()[0] == marker.as_bytes()[0] && marker.len() >= s.len())
            {
                fence = None;
            }
            continue;
        }
        if fence.is_none()
            && let Some(request) = REQUEST.captures(line)
            && (i == 0 || control)
        {
            replacement = Some(
                format!("{}\n{}", &request[1], lines[i + 1..].join("\n"))
                    .trim()
                    .to_owned(),
            );
            break;
        }
    }
    if let Some(replacement) = replacement {
        value = replacement;
    }
    if AGENTS.is_match(&value) {
        return None;
    }
    while let Some((tag, end)) = control_start(&value) {
        if !is_control_tag(tag) {
            break;
        }
        let closing = format!("</{tag}>");
        let close_re = Regex::new(&format!("(?i){}", regex::escape(&closing))).unwrap();
        let Some(position) = close_re.find(&value[end..]).map(|m| m.start()) else {
            break;
        };
        value = value[end + position + closing.len()..]
            .trim_start()
            .to_owned();
    }
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then_some(value)
}
pub fn user_titles(row: &Value) -> Option<(String, Option<String>)> {
    let raw = match row["type"].as_str()? {
        "user"
            if row["message"].is_object()
                && (row["message"].get("role").is_none() || row["message"]["role"] == "user") =>
        {
            content(&row["message"]["content"])
        }
        "event_msg" if row["payload"]["type"] == "user_message" => {
            row["payload"]["message"].as_str().map(str::to_owned)
        }
        "response_item"
            if row["payload"]["type"] == "message" && row["payload"]["role"] == "user" =>
        {
            content(&row["payload"]["content"])
        }
        _ => None,
    }?;
    let cleaned = clean(&raw)?;
    let title = cleaned.chars().take(40).collect();
    let speech = if cleaned.contains('@') {
        let compact = compact_references(&cleaned);
        let short: String = compact.chars().take(SPEECH_TITLE_MAX).collect();
        if short == cleaned.chars().take(SPEECH_TITLE_MAX).collect::<String>() {
            None
        } else {
            Some(short)
        }
    } else {
        None
    };
    Some((title, speech))
}
