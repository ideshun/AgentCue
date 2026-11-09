use chrono::{DateTime, Utc};
use serde_json::{Value, json};
pub fn parse(value: &Value, format: &str, tool: &str) -> Result<Vec<Value>, String> {
    let entries: Vec<&Value> = match format {
        "cline-history-v1" => value
            .as_array()
            .ok_or("不支持的历史索引格式")?
            .iter()
            .collect(),
        "cline-sessions-v1" if value["version"] == 1 => value["sessions"]
            .as_object()
            .ok_or("不支持的会话索引格式")?
            .values()
            .collect(),
        _ => return Err("不支持的历史索引格式".into()),
    };
    let mut result = vec![];
    for item in entries {
        if !item.is_object() {
            continue;
        }
        let history = format == "cline-history-v1";
        let Some(id) = item[if history { "id" } else { "sessionId" }]
            .as_str()
            .filter(|s| !s.is_empty() && s.chars().count() <= 500)
        else {
            continue;
        };
        let stamp = if history {
            &item["ts"]
        } else {
            item.get("updatedAt")
                .filter(|v| !v.is_null())
                .unwrap_or(&item["startedAt"])
        };
        let time = if let Some(ms) = stamp.as_i64() {
            DateTime::<Utc>::from_timestamp_millis(ms)
        } else {
            stamp
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.with_timezone(&Utc))
        };
        let Some(time) = time else {
            continue;
        };
        let title = item[if history { "task" } else { "prompt" }]
            .as_str()
            .map(|s| {
                s.split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(120)
                    .collect::<String>()
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "未命名历史任务".into());
        let mut entry = json!({"kind":"history","sessionId":format!("{tool}:history:{id}"),"toolId":tool,"title":title,"currentState":null,"updatedAt":time.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
        if let Some(status) = item["status"].as_str() {
            entry["sourceStatus"] = json!(status.chars().take(60).collect::<String>());
        }
        result.push(entry);
    }
    Ok(result)
}
