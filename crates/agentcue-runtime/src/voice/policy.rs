use agentcue_adapters::text::compact_references;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::LazyLock,
    time::{Duration, Instant},
};
const UNTITLED_SPEECH: &str = "未命名任务";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub event_id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub event_type: String,
    pub session_id: String,
    pub title: Option<String>,
    pub speech_title: Option<String>,
}
pub fn truncate(text: &str, max: usize) -> String {
    let value = text.trim();
    if value.chars().count() <= max {
        return value.into();
    }
    if max == 0 {
        return String::new();
    }
    format!("{}…", value.chars().take(max - 1).collect::<String>())
}
pub fn task_title(signal: &Signal, max: usize) -> String {
    if let Some(title) = signal.title.as_deref().filter(|s| !s.trim().is_empty()) {
        return truncate(title, max);
    }
    truncate(UNTITLED_SPEECH, max)
}
pub fn spoken_title(signal: &Signal, max: usize) -> String {
    static RULES: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
        vec![
            (Regex::new(r"(?s)```.*?```").unwrap(), " "),
            (Regex::new(r"`[^`]*`").unwrap(), " "),
            (Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").unwrap(), "$1"),
            (Regex::new(r"https?://\S+").unwrap(), " "),
            (Regex::new(r"(?m)^[ \t]*#{1,6}[ \t]*").unwrap(), ""),
            (Regex::new(r"[*_>~]+").unwrap(), " "),
        ]
    });
    let mut text = signal.title.clone().unwrap_or_default();
    for (re, replacement) in RULES.iter() {
        text = re.replace_all(&text, *replacement).into_owned();
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let clause = text
        .split(['。', '！', '？', '!', '?', '；', ';'])
        .next()
        .unwrap_or_default()
        .trim();
    let label = clause
        .chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned();
    if label.is_empty() {
        return UNTITLED_SPEECH.into();
    }
    if clause.chars().count() > max {
        format!("{label}…")
    } else {
        label
    }
}
pub fn tool_name(signal: &Signal) -> String {
    truncate(
        if signal.tool_name.trim().is_empty() {
            &signal.tool_id
        } else {
            &signal.tool_name
        },
        40,
    )
}
pub fn template(event: &str) -> &'static str {
    match event {
        "task.started" => "{tool} 开始处理，{title}。",
        "task.waiting_human" => "{tool} 有个任务等你确认，{title}。",
        "task.completed" => "{tool} 的任务已经完成，{title}。",
        "task.failed" => "{tool} 的任务失败了，{title}，请查看。",
        "task.timeout" => "{tool} 的确认等待超时了，{title}。",
        "human.responded" => "{tool} 继续执行，{title}。",
        "task.retried" => "{tool} 正在重试，{title}。",
        "task.archived" => "{tool} 的任务已归档，{title}。",
        "task.cancelled" => "{tool} 的任务已取消，{title}。",
        "heartbeat.lost" => "{tool} 的连接中断了，{title}，请查看。",
        "tool.detected" => "{tool} 已被识别，任务 {title}。",
        _ => "{tool} 出现异常信号，{title}，请查看。",
    }
}
pub fn label(event: &str) -> &'static str {
    match event {
        "task.started" => "任务开始",
        "task.waiting_human" => "等你拍板",
        "human.responded" => "已恢复执行",
        "task.failed" => "任务失败",
        "task.completed" => "任务完成",
        "task.retried" => "重试中",
        "task.archived" => "已归档",
        "task.timeout" => "等待超时",
        "task.cancelled" => "已取消",
        "heartbeat.lost" => "心跳丢失",
        "tool.detected" => "发现工具",
        _ => "异常信号",
    }
}
pub fn attention(event: &str) -> bool {
    [
        "task.waiting_human",
        "task.failed",
        "task.timeout",
        "heartbeat.lost",
    ]
    .contains(&event)
}
pub fn automatic(event: &str) -> bool {
    ["task.started", "task.waiting_human", "task.completed"].contains(&event)
}
pub fn in_scope(scope: &str, event: &str) -> bool {
    scope == "all" || (scope == "milestones" && automatic(event)) || event == "task.waiting_human"
}
pub fn priority(event: &str) -> u8 {
    match event {
        "task.waiting_human" | "task.failed" => 3,
        "task.timeout" | "heartbeat.lost" => 2,
        _ => 1,
    }
}
pub fn match_rule<'a>(rules: &'a [Value], signal: &Signal) -> Option<&'a Value> {
    rules
        .iter()
        .filter(|r| {
            r["scopeTool"]
                .as_str()
                .filter(|s| !s.is_empty())
                .is_none_or(|s| s == signal.tool_id)
                && (r["scopeEvent"] == "*" || r["scopeEvent"] == signal.event_type)
        })
        .fold(None, |best, rule| {
            let score = |r: &Value| {
                u8::from(r["scopeTool"].as_str().is_some_and(|s| !s.is_empty())) * 2
                    + u8::from(r["scopeEvent"] != "*")
            };
            if best.is_none_or(|b| score(rule) > score(b)) {
                Some(rule)
            } else {
                best
            }
        })
}
pub fn render(template: &str, signal: &Signal, title_limit: usize) -> String {
    static VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{([A-Za-z0-9_]+)\}").unwrap());
    let rendered = VAR.replace_all(template, |c: &Captures| match &c[1] {
        "tool" => tool_name(signal),
        "title" => task_title(signal, title_limit),
        "event" => signal.event_type.clone(),
        _ => c[0].into(),
    });
    truncate(&rendered, 200)
}
pub fn announcement(signal: &Signal, config: &Value, rule: Option<&Value>) -> String {
    let title = signal
        .speech_title
        .as_ref()
        .filter(|title| !title.trim().is_empty())
        .or(signal.title.as_ref());
    let compact = title.map(|s| compact_references(s));
    let has_reference = signal.speech_title.is_some() || compact.as_ref() != title;
    let mut speech = Signal {
        title: compact,
        ..signal.clone()
    };
    let max = if has_reference { 60 } else { 40 };
    if config["voice"]["content"] != "prompt" {
        speech.title = Some(spoken_title(&speech, if has_reference { 60 } else { 24 }));
    } else if speech
        .title
        .as_deref()
        .is_none_or(|title| title.trim().is_empty())
    {
        speech.title = Some(UNTITLED_SPEECH.into());
    }
    let text = rule
        .and_then(|r| r["template"].as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| template(&signal.event_type));
    let mut body = render(text, &speech, max);
    let tool = tool_name(&speech);
    let title = task_title(&speech, max);
    let mut identity = vec![];
    if !body.contains(&tool) {
        identity.push(tool.clone());
    }
    if !body.contains(&title) {
        identity.push(format!("「{title}」"));
    }
    if !identity.is_empty() {
        let prefix = format!("{}，", identity.join(" · "));
        body = if prefix.chars().count() + body.chars().count() <= 200 {
            prefix + &body
        } else {
            let prefix = format!("{tool} · 「{title}」，");
            format!(
                "{prefix}{}",
                truncate(&body, 200_usize.saturating_sub(prefix.chars().count()))
            )
        };
    }
    truncate(&normalize(&body), 200)
}
pub fn normalize(text: &str) -> String {
    static TIME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(^|[^0-9:])([0-9]{1,2}):([0-9]{2})").unwrap());
    static PERCENT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"([0-9]+(?:\.[0-9]+)?)\s*%").unwrap());
    static VERSION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(^|\s)[vV]([0-9]+(?:\.[0-9]+)+)").unwrap());
    static UNITS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB|KB|ms|s)").unwrap());
    let mut text = compact_references(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    text = TIME
        .replace_all(&text, |c: &Captures| {
            if text[c.get(0).unwrap().end()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit() || c == ':')
            {
                c[0].into()
            } else {
                format!("{}{} 点 {} 分", &c[1], &c[2], &c[3])
            }
        })
        .into_owned();
    text = PERCENT.replace_all(&text, "百分之 $1").into_owned();
    text = VERSION
        .replace_all(&text, |c: &Captures| {
            if text[c.get(0).unwrap().end()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
            {
                c[0].into()
            } else {
                format!("{}版本 {}", &c[1], &c[2])
            }
        })
        .into_owned();
    text = UNITS
        .replace_all(&text, |c: &Captures| {
            if text[c.get(0).unwrap().end()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
            {
                c[0].into()
            } else {
                format!(
                    "{} {}",
                    &c[1],
                    match &c[2] {
                        "TB" => "太字节",
                        "GB" => "吉字节",
                        "MB" => "兆字节",
                        "KB" => "千字节",
                        "ms" => "毫秒",
                        _ => "秒",
                    }
                )
            }
        })
        .into_owned();
    text
}
pub fn quiet(config: &Value, event: &str, minutes: u32) -> bool {
    let q = &config["quiet"];
    if q["globalMute"] == true {
        return true;
    }
    if q["waitingHumanOverride"] == true && event == "task.waiting_human" {
        return false;
    }
    q["ranges"].as_array().is_some_and(|ranges| {
        ranges.iter().any(|r| {
            let number = |key: &str| {
                r[key]
                    .as_str()
                    .and_then(|s| s.split_once(':'))
                    .and_then(|(h, m)| h.parse::<u32>().ok().zip(m.parse::<u32>().ok()))
                    .filter(|(h, m)| *h < 24 && *m < 60)
                    .map(|(h, m)| h * 60 + m)
            };
            match (number("from"), number("to")) {
                (Some(from), Some(to)) if from <= to => minutes >= from && minutes <= to,
                (Some(from), Some(to)) => minutes >= from || minutes <= to,
                _ => false,
            }
        })
    })
}
#[derive(Default)]
pub struct Dedupe {
    ids: HashSet<String>,
    order: VecDeque<String>,
    last: HashMap<(String, String), Instant>,
    global: Option<Instant>,
}
impl Dedupe {
    /// Stable ids survive playback and reconfiguration. Fresh milestones wait through cooldown, never replay.
    pub fn accept(&mut self, signal: &Signal, now: Instant) -> Option<Duration> {
        if self.ids.contains(&signal.event_id) {
            return None;
        }
        let key = (signal.session_id.clone(), signal.event_type.clone());
        if self
            .last
            .get(&key)
            .is_some_and(|last| now.saturating_duration_since(*last) < Duration::from_secs(30))
        {
            return None;
        }
        let delay = self
            .global
            .map(|last| Duration::from_secs(2).saturating_sub(now.saturating_duration_since(last)))
            .unwrap_or_default();
        self.ids.insert(signal.event_id.clone());
        self.order.push_back(signal.event_id.clone());
        while self.order.len() > 4096 {
            if let Some(old) = self.order.pop_front() {
                self.ids.remove(&old);
            }
        }
        self.last.insert(key, now);
        if self.last.len() > 1024 {
            self.last
                .retain(|_, at| now.saturating_duration_since(*at) < Duration::from_secs(300));
        }
        self.global = Some(now);
        Some(delay)
    }
}
