//! Newline JSON-RPC bridge. This module never opens a database or starts the desktop host.
use crate::paths;
use serde_json::{Value, json};
use std::{io, path::PathBuf, time::Duration};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
pub const PROTOCOL: &str = "2025-06-18";
pub const MAX_BYTES: usize = 1024 * 1024;
pub fn tools() -> Value {
    serde_json::from_str(include_str!("../resources/mcp-tools.json")).expect("embedded MCP tools")
}
fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn rpc_success(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn unavailable() -> Value {
    json!({"success":false,"error":{"code":"ENGINE_UNAVAILABLE","message":"无法连接本机控制服务，请先启动 AgentCue"}})
}

pub struct ControlClient {
    pub data_dir: PathBuf,
    client: reqwest::Client,
}
impl ControlClient {
    pub fn new(data_dir: PathBuf) -> io::Result<Self> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(io::Error::other)?;
        Ok(Self { data_dir, client })
    }
    pub async fn invoke(&self, name: &str, args: &Value) -> Value {
        let info = match paths::read_runtime(&self.data_dir) {
            Ok(v) => v,
            Err(_) => return unavailable(),
        };
        let mut url = reqwest::Url::parse(&format!("http://127.0.0.1:{}/api/v1/", info.api_port))
            .expect("loopback URL");
        let mut method = reqwest::Method::GET;
        let segments: Vec<&str> = match name {
            "list_tools" => vec!["tools"],
            "list_sessions" => vec!["sessions"],
            "get_task_status" => vec!["sessions", args["sessionId"].as_str().unwrap_or_default()],
            "update_task_state" => {
                method = reqwest::Method::POST;
                vec![
                    "tasks",
                    args["sessionId"].as_str().unwrap_or_default(),
                    "state",
                ]
            }
            "set_voice_rule" => {
                method = reqwest::Method::POST;
                vec!["voice", "rules"]
            }
            "get_timeline" => vec![
                "sessions",
                args["sessionId"].as_str().unwrap_or_default(),
                "timeline",
            ],
            _ => {
                return json!({"success":false,"error":{"code":"INVALID_PARAM","message":"未知工具"}});
            }
        };
        url.path_segments_mut()
            .unwrap()
            .pop_if_empty()
            .extend(segments);
        if name == "list_sessions" {
            for key in ["state", "toolId", "limit"] {
                if let Some(v) = args.get(key) {
                    url.query_pairs_mut().append_pair(
                        key,
                        &v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string()),
                    );
                }
            }
        } else if name == "get_timeline"
            && let Some(v) = args.get("limit")
        {
            url.query_pairs_mut().append_pair("limit", &v.to_string());
        }
        let mut request = self
            .client
            .request(method.clone(), url)
            .bearer_auth(info.token);
        if method == reqwest::Method::POST {
            request = request.json(args);
        }
        let result = async {
            let mut response = request.send().await.map_err(|_| ())?;
            let mut bytes = vec![];
            while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
                if bytes.len() + chunk.len() > 16 * MAX_BYTES {
                    return Err(());
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
            if !value["success"].is_boolean() {
                return Err(());
            }
            Ok(value)
        }
        .await;
        result.unwrap_or_else(|_| unavailable())
    }
}
#[derive(Default)]
pub struct Server {
    initialized: bool,
    ready: bool,
}
impl Server {
    pub async fn handle(&mut self, raw: Value, client: &ControlClient) -> Option<Value> {
        if !raw.is_object() || raw["jsonrpc"] != "2.0" || !raw["method"].is_string() {
            return Some(rpc_error(Value::Null, -32600, "无效 JSON-RPC 请求"));
        }
        if raw
            .get("id")
            .is_some_and(|v| !v.is_string() && !v.is_number() && !v.is_null())
        {
            return Some(rpc_error(Value::Null, -32600, "无效请求编号"));
        }
        let method = raw["method"].as_str().unwrap();
        if raw.get("id").is_none() {
            if method == "notifications/initialized" && self.initialized {
                self.ready = true;
            }
            return None;
        }
        let id = raw["id"].clone();
        if method == "ping" {
            return Some(rpc_success(id, json!({})));
        }
        if method == "initialize" {
            if self.initialized {
                return Some(rpc_error(id, -32600, "连接已初始化"));
            }
            let p = &raw["params"];
            if !p["protocolVersion"].is_string()
                || !p["capabilities"].is_object()
                || !p["clientInfo"]["name"].is_string()
                || !p["clientInfo"]["version"].is_string()
            {
                return Some(rpc_error(id, -32602, "初始化参数无效"));
            }
            self.initialized = true;
            return Some(rpc_success(
                id,
                json!({"protocolVersion":PROTOCOL,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"ai-workflow-monitor","version":env!("CARGO_PKG_VERSION")},"instructions":"AgentCue：AI 编码任务的本地监控台。状态标记只更新本应用记录，不会操作原工具。"}),
            ));
        }
        if !self.ready {
            return Some(rpc_error(id, -32002, "请先完成初始化"));
        }
        if method == "tools/list" {
            return Some(rpc_success(id, json!({"tools":tools()})));
        }
        if method != "tools/call" {
            return Some(rpc_error(id, -32601, "未实现的方法"));
        }
        let p = &raw["params"];
        let name = p["name"].as_str().unwrap_or_default();
        let definitions = tools();
        let Some(definition) = definitions
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == name)
        else {
            return Some(rpc_error(id, -32602, "未知工具"));
        };
        let args = p.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if !valid_args(&definition["inputSchema"], &args) {
            return Some(rpc_error(id, -32602, "工具参数无效"));
        }
        let envelope = client.invoke(name, &args).await;
        Some(rpc_success(
            id,
            json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&envelope).unwrap()}],"isError":envelope["success"]==false}),
        ))
    }
}
fn valid_args(schema: &Value, args: &Value) -> bool {
    let Some(obj) = args.as_object() else {
        return false;
    };
    if schema["required"]
        .as_array()
        .is_some_and(|keys| keys.iter().any(|k| !obj.contains_key(k.as_str().unwrap())))
    {
        return false;
    }
    let properties = schema["properties"].as_object().unwrap();
    for (key, value) in obj {
        let Some(rule) = properties.get(key) else {
            return false;
        };
        match rule["type"].as_str() {
            Some("string") => {
                let Some(s) = value.as_str() else {
                    return false;
                };
                if rule["minLength"]
                    .as_u64()
                    .is_some_and(|n| s.chars().count() < (n as usize))
                {
                    return false;
                }
            }
            Some("integer") => {
                let Some(n) = value.as_i64() else {
                    return false;
                };
                if rule["minimum"].as_i64().is_some_and(|v| n < v)
                    || rule["maximum"].as_i64().is_some_and(|v| n > v)
                {
                    return false;
                }
            }
            _ => return false,
        }
        if rule["enum"]
            .as_array()
            .is_some_and(|choices| !choices.contains(value))
        {
            return false;
        }
    }
    true
}
/// Bounded framing also protects against a peer sending a huge unterminated line.
pub async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut line = vec![];
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let end = buffer.iter().position(|b| *b == b'\n');
        let len = end.map(|p| p + 1).unwrap_or(buffer.len());
        if line.len() + len > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "MCP 消息超过大小上限",
            ));
        }
        line.extend_from_slice(&buffer[..len]);
        reader.consume(len);
        if end.is_some() {
            return Ok(Some(line));
        }
    }
}
pub async fn run_stdio<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    input: R,
    mut output: W,
    data_dir: PathBuf,
) -> io::Result<()> {
    let mut reader = BufReader::new(input);
    let mut server = Server::default();
    let client = ControlClient::new(data_dir)?;
    while let Some(line) = read_line(&mut reader, MAX_BYTES).await? {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let response = match serde_json::from_slice(&line) {
            Ok(raw) => server.handle(raw, &client).await,
            Err(_) => Some(rpc_error(Value::Null, -32700, "JSON 解析失败")),
        };
        if let Some(response) = response {
            output.write_all(response.to_string().as_bytes()).await?;
            output.write_all(b"\n").await?;
            output.flush().await?;
        }
    }
    Ok(())
}
