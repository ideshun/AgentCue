use agentcue_core::TaskState;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{
    Connection, params_from_iter,
    types::{Value as Sql, ValueRef},
};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn rows(db: &Connection, sql: &str, params: Vec<Sql>) -> rusqlite::Result<Vec<Value>> {
    let mut statement = db.prepare(sql)?;
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    statement
        .query_map(params_from_iter(params), |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                    ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidQuery),
                };
                obj.insert(name.clone(), value);
            }
            Ok(Value::Object(obj))
        })?
        .collect()
}
fn s(value: &str) -> Sql {
    Sql::Text(value.to_owned())
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
const SESSION: &str = "session_id AS sessionId,tool_id AS toolId,title,current_state AS currentState,updated_at AS updatedAt";
pub fn sessions(
    db: &Connection,
    states: &[&str],
    tool: Option<&str>,
    q: Option<&str>,
    before: Option<(&str, &str)>,
    limit: usize,
) -> rusqlite::Result<Vec<Value>> {
    let (condition, mut values) = conditions(states, tool, q, before);
    values.push(Sql::Integer(limit as i64));
    rows(
        db,
        &format!(
            "SELECT {SESSION} FROM sessions WHERE {condition} ORDER BY updated_at DESC,session_id DESC LIMIT ?"
        ),
        values,
    )
}
fn conditions(
    states: &[&str],
    tool: Option<&str>,
    q: Option<&str>,
    before: Option<(&str, &str)>,
) -> (String, Vec<Sql>) {
    let mut terms = vec!["visible=1".to_owned()];
    let mut p = vec![];
    if !states.is_empty() {
        terms.push(format!(
            "current_state IN ({})",
            vec!["?"; states.len()].join(",")
        ));
        p.extend(states.iter().map(|v| s(v)));
    }
    if let Some(tool) = tool {
        terms.push("tool_id=?".into());
        p.push(s(tool));
    }
    if let Some(q) = q.filter(|q| !q.trim().is_empty()) {
        let pattern = format!(
            "%{}%",
            q.trim()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        terms.push(r"(title LIKE ? ESCAPE '\' OR tool_id LIKE ? ESCAPE '\' OR session_id LIKE ? ESCAPE '\')".into());
        p.extend([s(&pattern), s(&pattern), s(&pattern)]);
    }
    if let Some((time, id)) = before {
        terms.push("(updated_at<? OR (updated_at=? AND session_id<?))".into());
        p.extend([s(time), s(time), s(id)]);
    }
    (terms.join(" AND "), p)
}
pub fn count(
    db: &Connection,
    states: &[&str],
    tool: Option<&str>,
    q: Option<&str>,
) -> rusqlite::Result<i64> {
    let (condition, params) = conditions(states, tool, q, None);
    db.query_row(
        &format!("SELECT count(*) FROM sessions WHERE {condition}"),
        params_from_iter(params),
        |row| row.get(0),
    )
}
pub fn timeline(db: &Connection, id: &str, limit: usize) -> rusqlite::Result<Vec<Value>> {
    rows(
        db,
        "SELECT event_id AS eventId,session_id AS sessionId,event_type AS eventType,prev_state AS prevState,next_state AS nextState,actor,reason,ts FROM state_events WHERE session_id=? ORDER BY julianday(ts) DESC,rowid DESC LIMIT ?",
        vec![s(id), Sql::Integer(limit as i64)],
    )
}
pub fn status(db: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    let session = rows(
        db,
        "SELECT current_state AS state FROM sessions WHERE session_id=?",
        vec![s(id)],
    )?;
    match session.first() {
        None => Ok(None),
        Some(v) => Ok(Some(
            json!({"state":v["state"],"recent":timeline(db,id,5)?}),
        )),
    }
}
pub fn counts(db: &Connection, tool: Option<&str>) -> rusqlite::Result<Value> {
    let mut obj = serde_json::Map::new();
    for state in TaskState::ALL {
        obj.insert(
            state.as_str().into(),
            json!(count(db, &[state.as_str()], tool, None)?),
        );
    }
    Ok(Value::Object(obj))
}
pub fn tools(
    db: &Connection,
    manifests: &[Value],
    settings: &Value,
) -> rusqlite::Result<Vec<Value>> {
    let mut tools = rows(
        db,
        "SELECT tool_id AS toolId,name,detect_status AS detectStatus,version,ignored FROM tools ORDER BY first_seen_at,tool_id",
        vec![],
    )?;
    for item in &mut tools {
        let id = item["toolId"].as_str().unwrap_or_default().to_owned();
        let manifest = manifests.iter().find(|v| v["id"] == id);
        let hook = manifest
            .and_then(|v| v.get("hookConfig"))
            .is_some_and(|v| v.is_object());
        let time:Option<String>=db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(ts))) FROM state_events WHERE tool_id=? AND substr(event_id,1,9)='evt_hook_'",[&id],|r|r.get(0))?;
        item["sessionCount"] = json!(count(db, &["running", "waiting_human"], Some(&id), None)?);
        item["ignored"] = json!(
            settings["scan"]["ignoredToolIds"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == &id))
        );
        item["hookSupported"] = json!(hook);
        item["hookLastEventAt"] = json!(time);
        let capability = if time.is_some() {
            "events"
        } else {
            manifest
                .and_then(|v| v["sessionCapability"].as_str())
                .unwrap_or_else(|| {
                    if manifest.is_some_and(|v| {
                        v["eventMapping"].as_object().is_some_and(|o| !o.is_empty())
                    }) {
                        "events"
                    } else {
                        "detect-only"
                    }
                })
        };
        item["sessionCapability"] = json!(capability);
        item["capabilityReason"] = manifest
            .map(|v| v["capabilityReason"].clone())
            .unwrap_or(Value::Null);
        item["host"] = manifest
            .map(|v| v["detect"]["extensions"][0]["host"].clone())
            .unwrap_or(Value::Null);
    }
    Ok(tools)
}
const GROUPS: [(&str, &[&str]); 4] = [
    ("attention", &["waiting_human"]),
    ("running", &["running"]),
    ("failed", &["failed", "timeout"]),
    ("completed", &["completed", "cancelled", "idle"]),
];
pub fn office(db: &Connection, manifests: &[Value], settings: &Value) -> rusqlite::Result<Value> {
    let tools = tools(db, manifests, settings)?;
    let mut desks = vec![];
    for tool in tools {
        let id = tool["toolId"].as_str().unwrap_or_default();
        let mut tasks = vec![];
        for (_, states) in GROUPS {
            let mut group = sessions(db, states, Some(id), None, None, 4)?;
            for row in &mut group {
                row["kind"] = json!("session")
            }
            tasks.extend(group);
        }
        let time:Option<String>=db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(e.ts))) FROM state_events e JOIN sessions s ON e.session_id=s.session_id WHERE s.visible=1 AND e.tool_id=?",[id],|r|r.get(0))?;
        desks.push(
            json!({"toolId":id,"counts":counts(db,Some(id))?,"lastEventAt":time,"tasks":tasks}),
        );
    }
    Ok(json!({"workstations":desks,"generatedAt":now()}))
}
pub fn board(
    db: &Connection,
    query: &HashMap<String, String>,
    history: &[Value],
) -> Result<Value, String> {
    let q = query.get("q").map(String::as_str).unwrap_or("");
    let tool = query.get("toolId").map(String::as_str).unwrap_or("");
    if q.chars().count() > 200 || tool.chars().count() > 200 {
        return Err("筛选条件过长".into());
    }
    let limit = query
        .get("limit")
        .map(|s| s.parse::<usize>())
        .transpose()
        .map_err(|_| "分页大小无效")?
        .unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err("分页大小无效".into());
    }
    let group = query.get("group").map(String::as_str);
    if group.is_some_and(|g| g != "history" && !GROUPS.iter().any(|v| v.0 == g)) {
        return Err("看板列无效".into());
    }
    let cursor = if let Some(encoded) = query.get("cursor") {
        if encoded.len() > 2048 {
            return Err("分页游标过长".into());
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "分页游标无效")?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| "分页游标无效")?;
        if group.is_none()
            || v["group"] != group.unwrap_or_default()
            || v["q"] != q
            || v["toolId"] != tool
            || v["updatedAt"]
                .as_str()
                .is_none_or(|t| chrono::DateTime::parse_from_rfc3339(t).is_err())
            || v["sessionId"].as_str().is_none_or(|s| s.is_empty())
        {
            return Err("分页游标与筛选条件不匹配".into());
        }
        Some(v)
    } else {
        None
    };
    let before = cursor.as_ref().map(|v| {
        (
            v["updatedAt"].as_str().unwrap(),
            v["sessionId"].as_str().unwrap(),
        )
    });
    let tool_filter = (!tool.is_empty()).then_some(tool);
    let mut pages = vec![];
    for id in ["attention", "running", "failed", "completed", "history"] {
        if group.is_some_and(|g| g != id) {
            continue;
        }
        let (mut items, total) = if id == "history" {
            let term = q.trim().to_lowercase();
            let mut all: Vec<Value> = history
                .iter()
                .filter(|v| {
                    (tool.is_empty() || v["toolId"] == tool)
                        && (term.is_empty()
                            || format!(
                                "{} {} {}",
                                v["title"].as_str().unwrap_or_default(),
                                v["toolId"].as_str().unwrap_or_default(),
                                v["sessionId"].as_str().unwrap_or_default()
                            )
                            .to_lowercase()
                            .contains(&term))
                })
                .cloned()
                .collect();
            all.sort_by(|a, b| {
                (b["updatedAt"].as_str(), b["sessionId"].as_str())
                    .cmp(&(a["updatedAt"].as_str(), a["sessionId"].as_str()))
            });
            let total = all.len();
            let filtered = all
                .into_iter()
                .filter(|v| {
                    before.is_none_or(|(t, id)| {
                        let time = v["updatedAt"].as_str().unwrap_or_default();
                        time < t || (time == t && v["sessionId"].as_str().unwrap_or_default() < id)
                    })
                })
                .take(limit + 1)
                .collect();
            (filtered, total as i64)
        } else {
            let states = GROUPS.iter().find(|v| v.0 == id).unwrap().1;
            let mut items = sessions(db, states, tool_filter, Some(q), before, limit + 1)
                .map_err(|e| e.to_string())?;
            for v in &mut items {
                v["kind"] = json!("session")
            }
            (
                items,
                count(db, states, tool_filter, Some(q)).map_err(|e| e.to_string())?,
            )
        };
        let more = items.len() > limit;
        items.truncate(limit);
        let next = if more {
            items.last().map(|last|URL_SAFE_NO_PAD.encode(json!({"group":id,"q":q,"toolId":tool,"updatedAt":last["updatedAt"],"sessionId":last["sessionId"]}).to_string()))
        } else {
            None
        };
        pages.push(json!({"id":id,"items":items,"total":total,"nextCursor":next}));
    }
    Ok(json!({"groups":pages,"generatedAt":now()}))
}
