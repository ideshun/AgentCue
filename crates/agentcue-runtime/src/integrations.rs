use crate::{
    control::{ControlError, Result},
    state::Runtime,
};
use serde_json::{Value, json};

const MARKER: &str = "/__AGENTCUE_EXECUTABLE__";
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn replace_value(value: &mut Value, executable: &str) {
    match value {
        Value::String(s) if s == MARKER => *s = executable.into(),
        Value::Array(a) => {
            for v in a {
                replace_value(v, executable)
            }
        }
        Value::Object(o) => {
            for v in o.values_mut() {
                replace_value(v, executable)
            }
        }
        _ => {}
    }
}
pub fn mcp_snippets(runtime: &Runtime) -> Value {
    let mut values: Value = serde_json::from_str(include_str!("../resources/mcp-templates.json"))
        .expect("embedded MCP templates");
    let executable = runtime.executable.to_string_lossy();
    for value in values.as_array_mut().unwrap() {
        if let Some(content) = value["json"].as_str() {
            let updated = if value["format"] == "toml" {
                content.replace(
                    &serde_json::to_string(MARKER).unwrap(),
                    &serde_json::to_string(executable.as_ref()).unwrap(),
                )
            } else {
                let mut content: Value = serde_json::from_str(content).expect("embedded MCP JSON");
                replace_value(&mut content, &executable);
                serde_json::to_string_pretty(&content).unwrap()
            };
            value["json"] = json!(updated);
        }
        value["commandReady"] = json!(runtime.executable.is_file());
    }
    values
}
pub fn hooks(runtime: &Runtime) -> Result<Value> {
    let mut values: Value = serde_json::from_str(include_str!("../resources/hook-templates.json"))
        .expect("embedded hook templates");
    let config = runtime.config();
    let db = runtime.db.lock().map_err(|_| ControlError::unavailable())?;
    let executable = runtime.executable.to_string_lossy();
    for value in values.as_array_mut().unwrap() {
        let id = value["id"].as_str().unwrap_or_default().to_owned();
        for file in value["files"].as_array_mut().unwrap() {
            let content = file["content"]
                .as_str()
                .unwrap_or_default()
                .replace(&shell_quote(MARKER), &shell_quote(&executable));
            file["content"] = json!(content);
        }
        let stamp:Option<String>=db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(ts))) FROM state_events WHERE tool_id=? AND substr(event_id,1,9)='evt_hook_'",[&id],|row|row.get(0))?;
        value["lastEventAt"] = json!(stamp);
        value["commandReady"] = json!(cfg!(unix) && runtime.executable.is_file());
        value["enabled"] = json!(
            config["privacy"]["sessionFileRead"] == true
                && !config["scan"]["ignoredToolIds"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == &id))
        );
    }
    Ok(values)
}
