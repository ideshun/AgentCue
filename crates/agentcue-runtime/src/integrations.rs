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
        render_hook_files(value, &executable, std::env::consts::OS)?;
        let stamp:Option<String>=db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(ts))) FROM state_events WHERE tool_id=? AND substr(event_id,1,9)='evt_hook_'",[&id],|row|row.get(0))?;
        value["lastEventAt"] = json!(stamp);
        value["commandReady"] = json!(runtime.executable.is_file());
        value["enabled"] = json!(
            config["privacy"]["sessionFileRead"] == true
                && !config["scan"]["ignoredToolIds"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == &id))
        );
    }
    Ok(values)
}

/// Render platform-specific commands without interpolating unescaped text into JSON.
pub fn render_hook_files(value: &mut Value, executable: &str, platform: &str) -> Result<()> {
    let id = value["id"].as_str().unwrap_or_default().to_owned();
    let windows = platform == "windows";
    let path = if windows {
        executable.replace('\\', "/")
    } else {
        executable.into()
    };
    let replacement = if windows && id == "cursor" {
        format!("& '{}'", path.replace('\'', "''"))
    } else {
        shell_quote(&path)
    };
    fn commands(value: &mut Value, replacement: &str, force_bash: bool) {
        match value {
            Value::Object(map) => {
                if let Some(Value::String(command)) = map.get_mut("command") {
                    *command = command.replace(&shell_quote(MARKER), replacement);
                    if force_bash {
                        map.insert("shell".into(), json!("bash"));
                    }
                }
                for v in map.values_mut() {
                    commands(v, replacement, force_bash);
                }
            }
            Value::Array(values) => {
                for v in values {
                    commands(v, replacement, force_bash);
                }
            }
            _ => {}
        }
    }
    for file in value["files"]
        .as_array_mut()
        .ok_or_else(|| ControlError::invalid("接入模板无效"))?
    {
        if windows && id == "cline" {
            let name = file["path"]
                .as_str()
                .and_then(|p| p.rsplit('/').next())
                .ok_or_else(|| ControlError::invalid("Hook 名称无效"))?
                .to_owned();
            file["path"] = json!(format!("{}.ps1", file["path"].as_str().unwrap_or_default()));
            file["content"] = json!(format!(
                "$ErrorActionPreference = 'Stop'\r\n$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n$json = [Console]::In.ReadToEnd()\r\n$json | & '{}' '--tool-hook' 'cline' '--hook-phase' '{}'\r\nexit $LASTEXITCODE\r\n",
                path.replace('\'', "''"),
                name
            ));
            file["executable"] = json!(false);
        } else if file["path"].as_str().is_some_and(|p| p.ends_with(".json")) {
            let mut content: Value =
                serde_json::from_str(file["content"].as_str().unwrap_or_default())
                    .map_err(|_| ControlError::invalid("Hook JSON 模板无效"))?;
            commands(&mut content, &replacement, windows && id == "claude-code");
            file["content"] = json!(
                serde_json::to_string_pretty(&content).map_err(|_| ControlError::unavailable())?
            );
        } else {
            file["content"] = json!(
                file["content"]
                    .as_str()
                    .unwrap_or_default()
                    .replace(&shell_quote(MARKER), &replacement)
            );
        }
    }
    if windows {
        value["steps"].as_array_mut().unwrap().insert(0,json!(match id.as_str(){"cline"=>"需要支持 Windows .ps1 Hooks 的 Cline 版本；将脚本保存为 UTF-8 BOM 编码。","cursor"=>"Windows Hooks 由 Cursor 的 PowerShell 执行，配置内已使用对应调用语法。",_=>"Windows 需要 Git for Windows（Git Bash）；Claude Code 需支持 shell=bash 的版本。"}));
    }
    Ok(())
}
