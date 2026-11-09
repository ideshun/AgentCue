//! Short lived external MCP validation, never a task-event source or persistent connection.
use crate::{
    mcp::{self, MAX_BYTES, PROTOCOL},
    queries,
};
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use std::{collections::HashSet, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};
type Result<T> = std::result::Result<T, String>;
pub enum Config {
    Stdio { command: String, args: Vec<String> },
    Http { url: String },
}
pub struct Options {
    pub timeout: Duration,
    pub max_bytes: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(8),
            max_bytes: MAX_BYTES,
        }
    }
}
enum Transport {
    Stdio {
        child: Box<Child>,
        group_id: u32,
        input: Option<ChildStdin>,
        output: BufReader<ChildStdout>,
        stderr: JoinHandle<()>,
        received: usize,
        max: usize,
    },
    Http {
        client: reqwest::Client,
        url: reqwest::Url,
        headers: HeaderMap,
        received: usize,
        max: usize,
        initialized: bool,
    },
}
fn init() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"ai-workflow-monitor","version":env!("CARGO_PKG_VERSION")}}})
}
fn error_response(id: Value, method: &str) -> Value {
    if method == "ping" {
        json!({"jsonrpc":"2.0","id":id,"result":{}})
    } else {
        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client does not support this method"}})
    }
}
fn response(value: Value, id: i64) -> Result<Option<Value>> {
    if !value.is_object() || value["jsonrpc"] != "2.0" {
        return Err("MCP 返回的消息不是有效 JSON-RPC 对象".into());
    }
    if value["method"].is_string() {
        return Ok(None);
    }
    if value["id"] != id {
        return Err(format!("MCP 响应 id 不匹配（期待 {id}）"));
    }
    if value.get("error").is_some() {
        return Err(value["error"]["message"]
            .as_str()
            .unwrap_or("MCP 返回错误响应")
            .to_owned());
    }
    if !value["result"].is_object() {
        return Err("MCP 响应缺少有效 result".into());
    }
    Ok(Some(value["result"].clone()))
}
impl Transport {
    fn open(config: Config, max: usize) -> Result<Self> {
        match config {
            Config::Stdio { command, args } => {
                if command.trim().is_empty() {
                    return Err("请填写 MCP 可执行文件".into());
                }
                let mut process = Command::new(command);
                process
                    .args(args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);
                #[cfg(unix)]
                process.process_group(0);
                let mut child = process.spawn().map_err(|e| format!("MCP 启动失败：{e}"))?;
                let input = child.stdin.take();
                let output = BufReader::new(child.stdout.take().ok_or("MCP 输出管道不可用")?);
                let mut errors = child.stderr.take().ok_or("MCP 错误管道不可用")?;
                // Drain diagnostics without retaining potentially sensitive or unlimited output.
                let stderr = tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    while errors.read(&mut buffer).await.is_ok_and(|n| n > 0) {}
                });
                let group_id = child.id().ok_or("MCP 子进程不可用")?;
                Ok(Self::Stdio {
                    child: Box::new(child),
                    group_id,
                    input,
                    output,
                    stderr,
                    received: 0,
                    max,
                })
            }
            Config::Http { url } => {
                let url = reqwest::Url::parse(&url).map_err(|_| "MCP URL 无效")?;
                if !["http", "https"].contains(&url.scheme()) {
                    return Err("MCP URL 须使用 http 或 https".into());
                }
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|_| "MCP HTTP 客户端不可用")?;
                let mut headers = HeaderMap::new();
                headers.insert("content-type", HeaderValue::from_static("application/json"));
                headers.insert(
                    "accept",
                    HeaderValue::from_static("application/json, text/event-stream"),
                );
                Ok(Self::Http {
                    client,
                    url,
                    headers,
                    received: 0,
                    max,
                    initialized: false,
                })
            }
        }
    }
    async fn send(&mut self, value: &Value) -> Result<()> {
        match self {
            Self::Stdio { input, .. } => {
                let input = input.as_mut().ok_or("MCP 输入管道已经关闭")?;
                input
                    .write_all(format!("{value}\n").as_bytes())
                    .await
                    .map_err(|_| "MCP 输入管道失败")?;
                input
                    .flush()
                    .await
                    .map_err(|_| "MCP 输入管道失败".to_owned())
            }
            Self::Http {
                client,
                url,
                headers,
                ..
            } => {
                let response = client
                    .post(url.clone())
                    .headers(headers.clone())
                    .json(value)
                    .send()
                    .await
                    .map_err(|_| "MCP HTTP 请求失败")?;
                if !response.status().is_success() {
                    return Err(format!("MCP HTTP {}", response.status().as_u16()));
                }
                Ok(())
            }
        }
    }
    async fn request(&mut self, value: Value, id: i64) -> Result<Value> {
        if let Self::Stdio { .. } = self {
            self.send(&value).await?;
            loop {
                let line = if let Self::Stdio {
                    output,
                    received,
                    max,
                    ..
                } = self
                {
                    let line = mcp::read_line(output, max.saturating_sub(*received))
                        .await
                        .map_err(|e| format!("MCP 输出读取失败：{e}"))?
                        .ok_or("MCP 提前退出")?;
                    *received += line.len();
                    line
                } else {
                    unreachable!()
                };
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let parsed: Value = serde_json::from_slice(&line)
                    .map_err(|_| "MCP stdout 含非 JSON 协议消息；日志应写入 stderr")?;
                if parsed["jsonrpc"] == "2.0"
                    && parsed["method"].is_string()
                    && parsed.get("id").is_some()
                {
                    self.send(&error_response(
                        parsed["id"].clone(),
                        parsed["method"].as_str().unwrap(),
                    ))
                    .await?;
                    continue;
                }
                if let Some(result) = response(parsed, id)? {
                    return Ok(result);
                }
            }
        }
        let Self::Http {
            client,
            url,
            headers,
            received,
            max,
            ..
        } = self
        else {
            unreachable!()
        };
        let mut http = client
            .post(url.clone())
            .headers(headers.clone())
            .json(&value)
            .send()
            .await
            .map_err(|_| "MCP HTTP 请求失败")?;
        if !http.status().is_success() {
            return Err(format!("MCP HTTP {}", http.status().as_u16()));
        }
        if id == 1
            && let Some(session) = http.headers().get("mcp-session-id")
        {
            if session.as_bytes().len() > 1024 {
                return Err("MCP 会话标识过长".into());
            }
            headers.insert("mcp-session-id", session.clone());
        }
        let content = http
            .headers()
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .unwrap_or_default();
        let sse = content.contains("text/event-stream");
        if !sse && !content.contains("application/json") {
            return Err("MCP HTTP 响应须为 JSON 或 SSE".into());
        }
        let mut buffer = vec![];
        while let Some(chunk) = http.chunk().await.map_err(|_| "MCP HTTP 响应读取失败")? {
            *received += chunk.len();
            if *received > *max {
                return Err("MCP HTTP 响应超过验证大小上限".into());
            }
            buffer.extend_from_slice(&chunk);
            if !sse {
                continue;
            }
            while let Some((offset, len)) = separator(&buffer) {
                let frame =
                    std::str::from_utf8(&buffer[..offset]).map_err(|_| "MCP SSE 字符编码无效")?;
                let data = frame
                    .lines()
                    .filter_map(|s| {
                        s.strip_prefix("data:")
                            .map(|s| s.strip_prefix(' ').unwrap_or(s))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let payload = if data.is_empty() {
                    None
                } else {
                    Some(
                        serde_json::from_str::<Value>(&data)
                            .map_err(|_| "MCP SSE 返回无效 JSON")?,
                    )
                };
                buffer.drain(..offset + len);
                if let Some(payload) = payload {
                    if payload["jsonrpc"] == "2.0"
                        && payload["method"].is_string()
                        && payload.get("id").is_some()
                    {
                        let replied = client
                            .post(url.clone())
                            .headers(headers.clone())
                            .json(&error_response(
                                payload["id"].clone(),
                                payload["method"].as_str().unwrap(),
                            ))
                            .send()
                            .await
                            .map_err(|_| "MCP HTTP 客户端响应失败")?;
                        if !replied.status().is_success() {
                            return Err("MCP HTTP 客户端响应失败".into());
                        }
                        continue;
                    }
                    if let Some(result) = response(payload, id)? {
                        return Ok(result);
                    }
                }
            }
        }
        if !sse {
            let parsed = serde_json::from_slice(&buffer).map_err(|_| "MCP HTTP 返回无效 JSON")?;
            if let Some(result) = response(parsed, id)? {
                return Ok(result);
            }
        }
        Err("MCP HTTP 流结束前未返回匹配响应".into())
    }
    fn initialized(&mut self) {
        if let Self::Http {
            headers,
            initialized,
            ..
        } = self
        {
            headers.insert("mcp-protocol-version", HeaderValue::from_static(PROTOCOL));
            *initialized = true;
        }
    }
    async fn cleanup(&mut self) {
        match self {
            Self::Stdio {
                child,
                group_id,
                input,
                stderr,
                ..
            } => {
                drop(input.take());
                let exited = tokio::time::timeout(Duration::from_millis(150), child.wait())
                    .await
                    .is_ok();
                terminate_group(*group_id, false);
                tokio::time::sleep(Duration::from_millis(150)).await;
                terminate_group(*group_id, true);
                if !exited {
                    let _ = child.kill().await;
                }
                stderr.abort();
                let _ = (&mut *stderr).await;
            }
            Self::Http {
                client,
                url,
                headers,
                initialized,
                ..
            } => {
                if *initialized && headers.contains_key("mcp-session-id") {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(1),
                        client.delete(url.clone()).headers(headers.clone()).send(),
                    )
                    .await;
                }
            }
        }
    }
}
fn separator(bytes: &[u8]) -> Option<(usize, usize)> {
    (0..bytes.len()).find_map(|i| {
        if bytes[i..].starts_with(b"\n\n") {
            Some((i, 2))
        } else if bytes[i..].starts_with(b"\r\n\r\n") {
            Some((i, 4))
        } else {
            None
        }
    })
}
async fn enumerate(transport: &mut Transport) -> Result<Vec<Value>> {
    let first = transport.request(init(), 1).await?;
    if first["protocolVersion"] != PROTOCOL {
        return Err("MCP 协议版本不受支持".into());
    }
    if !first["capabilities"].is_object() || !first["serverInfo"]["name"].is_string() {
        return Err("MCP 初始化响应缺少 capabilities 或 serverInfo".into());
    }
    transport.initialized();
    transport
        .send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .await?;
    if !first["capabilities"]["tools"].is_object() {
        return Ok(vec![]);
    }
    let mut tools = vec![];
    let mut cursor = None;
    let mut cursors = HashSet::new();
    let mut names = HashSet::new();
    for page in 0..100 {
        let params = cursor
            .as_ref()
            .map(|v| json!({"cursor":v}))
            .unwrap_or_else(|| json!({}));
        let id = page + 2;
        let result = transport
            .request(
                json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":params}),
                id,
            )
            .await?;
        let list = result["tools"].as_array().ok_or("MCP 工具列表不是数组")?;
        for tool in list {
            let name = tool["name"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or("MCP 工具列表含无效工具名称")?;
            if !names.insert(name.to_owned()) {
                return Err("MCP 工具列表含重复名称".into());
            }
            let mut entry = json!({"name":name});
            if tool["description"].is_string() {
                entry["description"] = tool["description"].clone();
            }
            tools.push(entry);
        }
        match result.get("nextCursor") {
            None => return Ok(tools),
            Some(Value::String(s)) if cursors.insert(s.clone()) => cursor = Some(s.clone()),
            _ => return Err("MCP 分页游标无效或重复".into()),
        }
    }
    Err("MCP 工具分页超过验证上限".into())
}
pub async fn validate(config: Config, options: Options) -> Value {
    let outcome = match Transport::open(config, options.max_bytes) {
        Ok(mut transport) => {
            let result = tokio::time::timeout(options.timeout, enumerate(&mut transport))
                .await
                .unwrap_or_else(|_| Err("MCP 验证超时".into()));
            transport.cleanup().await;
            result
        }
        Err(error) => Err(error),
    };
    match outcome {
        Ok(tools) => {
            json!({"ok":true,"status":"disconnected","validationStatus":"verified","tools":tools,"lastValidatedAt":queries::now(),"lastError":null})
        }
        Err(error) => {
            json!({"ok":false,"status":"disconnected","validationStatus":"error","tools":[],"lastValidatedAt":queries::now(),"lastError":error,"error":error})
        }
    }
}

fn terminate_group(pid: u32, force: bool) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        // SAFETY: pid is the id of a process group created and owned by this validator.
        // The negative pid targets that group, including descendants of command wrappers.
        unsafe {
            libc::kill(
                -(pid as i32),
                if force { libc::SIGKILL } else { libc::SIGTERM },
            );
        }
    }
    #[cfg(windows)]
    if force {
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        if let Self::Stdio {
            group_id, stderr, ..
        } = self
        {
            terminate_group(*group_id, true);
            stderr.abort();
        }
    }
}
