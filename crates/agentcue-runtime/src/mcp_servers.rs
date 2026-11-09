use crate::{
    control::{self, ControlError},
    mcp_client::{self, Config, Options},
    queries,
    state::Runtime,
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
const COLUMNS: &str = "server_id AS serverId,name,transport,command,args,url,status,tools,validation_status AS validationStatus,last_validated_at AS lastValidatedAt,last_error AS lastError";
pub fn list(db: &Connection) -> control::Result<Value> {
    Ok(json!(queries::rows(
        db,
        &format!("SELECT {COLUMNS} FROM mcp_servers ORDER BY rowid"),
        vec![]
    )?))
}
pub async fn upsert(runtime: &Runtime, body: &Value) -> control::Result<Value> {
    let name = control::string(body, "name")?;
    if name.trim().is_empty() || name.chars().count() > 200 {
        return Err(ControlError::invalid("MCP 名称无效"));
    }
    let transport = control::string(body, "transport")?;
    let id = body
        .get("serverId")
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ControlError::invalid("MCP 服务编号无效"))
        })
        .transpose()?
        .map(str::to_owned)
        .unwrap_or_else(|| format!("mcp_{}", uuid::Uuid::new_v4()));
    let command = body
        .get("command")
        .map(|v| {
            v.as_str()
                .ok_or_else(|| ControlError::invalid("MCP command 无效"))
        })
        .transpose()?;
    let url = body
        .get("url")
        .map(|v| {
            v.as_str()
                .ok_or_else(|| ControlError::invalid("MCP URL 无效"))
        })
        .transpose()?;
    let args = body
        .get("args")
        .map(|v| {
            v.as_array()
                .ok_or_else(|| ControlError::invalid("MCP args 须为字符串数组"))
        })
        .transpose()?
        .map(|a| {
            a.iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| ControlError::invalid("MCP args 须为字符串数组"))
                })
                .collect::<control::Result<Vec<_>>>()
        })
        .transpose()?;
    let config = match transport {
        "stdio" => Config::Stdio {
            command: command
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| ControlError::invalid("请填写 MCP 可执行文件"))?
                .into(),
            args: args.clone().unwrap_or_default(),
        },
        "streamable-http" => {
            let parsed = reqwest::Url::parse(url.unwrap_or_default())
                .map_err(|_| ControlError::invalid("MCP URL 无效"))?;
            if !["http", "https"].contains(&parsed.scheme()) {
                return Err(ControlError::invalid("MCP URL 须使用 http 或 https"));
            }
            Config::Http {
                url: parsed.to_string(),
            }
        }
        _ => return Err(ControlError::invalid("MCP 传输方式无效")),
    };
    let validation = mcp_client::validate(config, Options::default()).await;
    let db = runtime.db.lock().map_err(|_| ControlError::unavailable())?;
    db.execute("INSERT INTO mcp_servers(server_id,name,transport,command,args,url,status,tools,validation_status,last_validated_at,last_error) VALUES(?1,?2,?3,?4,?5,?6,'disconnected',?7,?8,?9,?10) ON CONFLICT(server_id) DO UPDATE SET name=excluded.name,transport=excluded.transport,command=excluded.command,args=excluded.args,url=excluded.url,status=excluded.status,tools=excluded.tools,validation_status=excluded.validation_status,last_validated_at=excluded.last_validated_at,last_error=excluded.last_error",params![id,name,transport,command,args.map(|a|json!(a).to_string()),url,validation["tools"].to_string(),validation["validationStatus"].as_str(),validation["lastValidatedAt"].as_str(),validation["lastError"].as_str()])?;
    Ok(queries::rows(
        &db,
        &format!("SELECT {COLUMNS} FROM mcp_servers WHERE server_id=?"),
        vec![rusqlite::types::Value::Text(id)],
    )?
    .remove(0))
}
