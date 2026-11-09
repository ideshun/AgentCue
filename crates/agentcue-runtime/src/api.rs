//! Loopback-only control API. The existing renderer and stdio clients share this surface.
use crate::{
    control::{self, ControlError},
    queries,
    state::Runtime,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Query, Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response, Sse, sse::Event as SseEvent},
};
use futures_util::stream;
use rusqlite::{params, types::Value as Sql};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{broadcast, watch},
    task::JoinHandle,
};

#[derive(Default)]
struct Gate {
    tickets: HashMap<String, Instant>,
    buckets: HashMap<&'static str, (Instant, usize)>,
}
impl Gate {
    fn hit(&mut self, bucket: &'static str) -> bool {
        let now = Instant::now();
        let entry = self.buckets.entry(bucket).or_insert((now, 0));
        if now.duration_since(entry.0) >= Duration::from_secs(60) {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= 120
    }
    fn ticket(&mut self) -> String {
        let now = Instant::now();
        self.tickets.retain(|_, until| *until > now);
        let key = token();
        self.tickets
            .insert(key.clone(), now + Duration::from_secs(60));
        key
    }
    fn consume(&mut self, ticket: Option<&String>) -> bool {
        ticket
            .and_then(|t| self.tickets.remove(t))
            .is_some_and(|until| until > Instant::now())
    }
}
struct ApiState {
    runtime: Arc<Runtime>,
    token: String,
    gate: Mutex<Gate>,
    stopping: watch::Receiver<bool>,
}
pub struct ApiHandle {
    pub port: u16,
    pub token: String,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<std::io::Result<()>>,
}
impl ApiHandle {
    pub async fn close(self) -> std::io::Result<()> {
        let _ = self.shutdown.send(true);
        let mut task = self.task;
        match tokio::time::timeout(Duration::from_secs(3), &mut task).await {
            Ok(result) => result.map_err(std::io::Error::other)?,
            Err(_) => {
                task.abort();
                let _ = task.await;
                Ok(())
            }
        }
    }
}
pub fn token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
pub async fn start(runtime: Arc<Runtime>, port: u16) -> std::io::Result<ApiHandle> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await?;
    let port = listener.local_addr()?.port();
    let token = token();
    let (shutdown, mut stopping) = watch::channel(false);
    let state = Arc::new(ApiState {
        runtime,
        token: token.clone(),
        gate: Mutex::new(Gate::default()),
        stopping: stopping.clone(),
    });
    let router = Router::new().fallback(request).with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = stopping.changed().await;
            })
            .await
    });
    Ok(ApiHandle {
        port,
        token,
        shutdown,
        task,
    })
}
fn json_response(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        axum::Json(value),
    )
        .into_response()
}
fn failure(error: ControlError) -> Response {
    json_response(
        error.status,
        json!({"success":false,"error":{"code":error.code,"message":error.message}}),
    )
}
fn success(value: Value) -> Response {
    json_response(200, json!({"success":true,"data":value}))
}
fn cors(mut response: Response) -> Response {
    let h = response.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET,POST,PUT,DELETE,OPTIONS".parse().unwrap(),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "Authorization,Content-Type".parse().unwrap(),
    );
    h.insert(header::ACCESS_CONTROL_MAX_AGE, "86400".parse().unwrap());
    response
}
async fn request(State(state): State<Arc<ApiState>>, request: Request) -> Response {
    cors(handle(&state, request).await)
}
async fn handle(state: &Arc<ApiState>, request: Request) -> Response {
    let method = request.method().clone();
    if method == Method::OPTIONS {
        return StatusCode::NO_CONTENT.into_response();
    }
    let path = request.uri().path().to_owned();
    let query = match Query::<HashMap<String, String>>::try_from_uri(request.uri()) {
        Ok(Query(query)) => query,
        Err(_) => return failure(ControlError::invalid("查询参数无效")),
    };
    if path == "/api/v1/stream" && method == Method::GET {
        let accepted = state
            .gate
            .lock()
            .is_ok_and(|mut g| g.consume(query.get("ticket")));
        if !accepted {
            return failure(ControlError {
                status: 401,
                code: "INVALID_PARAM",
                message: "连接票据无效或已使用".into(),
            });
        }
        return event_stream(state);
    }
    let expected = format!("Bearer {}", state.token);
    let auth = request
        .headers()
        .get(header::AUTHORIZATION)
        .map(|v| v.as_bytes())
        .unwrap_or_default();
    if auth.len() != expected.len() || !bool::from(auth.ct_eq(expected.as_bytes())) {
        return failure(ControlError {
            status: 401,
            code: "INVALID_PARAM",
            message: "缺少或错误的 token".into(),
        });
    }
    let hook = path == "/api/v1/integrations/hooks" && method == Method::POST;
    if !state
        .gate
        .lock()
        .is_ok_and(|mut g| g.hit(if hook { "hooks" } else { "control" }))
    {
        return failure(ControlError {
            status: 429,
            code: "RATE_LIMITED",
            message: "请求过于频繁".into(),
        });
    }
    let body = if [Method::POST, Method::PUT, Method::DELETE].contains(&method) {
        let bytes = match tokio::time::timeout(
            Duration::from_secs(10),
            to_bytes(request.into_body(), 1024 * 1024),
        )
        .await
        {
            Ok(Ok(bytes)) => bytes,
            _ => return failure(ControlError::invalid("请求内容过大或读取超时")),
        };
        if bytes.is_empty() {
            json!({})
        } else {
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(v) if v.is_object() => v,
                _ => return failure(ControlError::invalid("请求内容须为 JSON 对象")),
            }
        }
    } else {
        Value::Null
    };
    let result = route(state, &method, &path, &query, &body).await;
    let response = match result {
        Ok(value) => value,
        Err(error) => failure(error),
    };
    if state.runtime.config()["privacy"]["auditLog"] == true {
        // Never persist URLs, identifiers, request contents, bearer tokens or credentials in audits.
        if let Ok(db) = state.runtime.db.lock() {
            let _ = db.execute(
                "INSERT INTO audit_log(ts,actor,action,result) VALUES(?1,'api',?2,?3)",
                params![
                    queries::now(),
                    format!("{method} {}", audit_route(&path)),
                    response.status().as_u16().to_string()
                ],
            );
        }
    }
    response
}
fn audit_route(path: &str) -> &str {
    let mut parts = path.trim_start_matches('/').split('/');
    if parts.next() != Some("api") || parts.next() != Some("v1") {
        return "unknown";
    }
    match parts.next() {
        Some(
            v @ ("health" | "overview" | "office" | "board" | "tools" | "sessions" | "tasks"
            | "events" | "notifications" | "settings" | "voice" | "mcp" | "adapters" | "scan"
            | "integrations" | "stream-ticket"),
        ) => v,
        _ => "unknown",
    }
}
fn event_stream(state: &ApiState) -> Response {
    let receiver = state.runtime.events.subscribe();
    let interval = tokio::time::interval(Duration::from_secs(30));
    let stopping = state.stopping.clone();
    let stream = stream::unfold(
        (receiver, interval, stopping),
        |(mut events, mut heartbeat, mut stop)| async move {
            if *stop.borrow() {
                return None;
            }
            let event = tokio::select! {
                _=stop.changed()=>return None,
                _=heartbeat.tick()=>SseEvent::default().event("heartbeat").data(json!({"ts":queries::now()}).to_string()),
                next=events.recv()=>match next {
                    Ok(value)=>SseEvent::default().event(value["type"].as_str().unwrap_or("board.updated")).data(value.to_string()),
                    Err(broadcast::error::RecvError::Lagged(_))=>SseEvent::default().event("settings.changed").data(json!({"type":"settings.changed","data":{},"ts":queries::now()}).to_string()),
                    Err(broadcast::error::RecvError::Closed)=>return None,
                }
            };
            Some((Ok::<_, Infallible>(event), (events, heartbeat, stop)))
        },
    );
    Sse::new(stream).into_response()
}
async fn route(
    state: &ApiState,
    method: &Method,
    path: &str,
    q: &HashMap<String, String>,
    body: &Value,
) -> control::Result<Response> {
    let runtime = &state.runtime;
    let config = runtime.config();
    let get = method == Method::GET;
    let post = method == Method::POST;
    if path == "/api/v1/health" && get {
        return Ok(json_response(
            200,
            json!({"ok":true,"version":env!("CARGO_PKG_VERSION"),"uptime":runtime.started.elapsed().as_secs()}),
        ));
    }
    if path == "/api/v1/stream-ticket" && post {
        let ticket = state
            .gate
            .lock()
            .map_err(|_| ControlError::unavailable())?
            .ticket();
        return Ok(success(json!({"ticket":ticket,"expiresInMs":60000})));
    }
    if path == "/api/v1/settings" {
        if get {
            return Ok(success(config));
        }
        if method == Method::PUT {
            return Ok(success(
                runtime
                    .update_settings(body)
                    .map_err(|e| ControlError::invalid(e.to_string()))?,
            ));
        }
    }
    if path == "/api/v1/scan" && post {
        let monitor = runtime
            .monitor
            .get()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(ControlError::unavailable)?;
        let summary = monitor
            .scan()
            .await
            .map_err(|_| ControlError::unavailable())?;
        return Ok(success(json!({"taskId":summary["scanId"]})));
    }
    if path == "/api/v1/overview" && get {
        return Ok(success(
            runtime
                .overview()
                .map_err(|_| ControlError::unavailable())?,
        ));
    }
    if path == "/api/v1/adapters" && get {
        return Ok(success(json!(runtime.manifests)));
    }
    if path == "/api/v1/mcp/snippets" && get {
        return Ok(success(crate::integrations::mcp_snippets(runtime)));
    }
    if path == "/api/v1/integrations/hooks" && post {
        let envelope = agentcue_adapters::hooks::parse(body).map_err(ControlError::invalid)?;
        return Ok(success(crate::hooks::consume(runtime, envelope).await?));
    }
    if path == "/api/v1/integrations/hooks" && get {
        return Ok(success(crate::integrations::hooks(runtime)?));
    }
    if path == "/api/v1/mcp/validate" && post {
        if !runtime.executable.is_file() {
            return Err(ControlError::invalid("MCP 桥接可执行文件不可用"));
        }
        let result = crate::mcp_client::validate(
            crate::mcp_client::Config::Stdio {
                command: runtime.executable.to_string_lossy().into_owned(),
                args: vec![
                    "--mcp-stdio".into(),
                    "--data-dir".into(),
                    runtime.data_dir.to_string_lossy().into_owned(),
                ],
            },
            Default::default(),
        )
        .await;
        return Ok(success(result));
    }
    if path == "/api/v1/mcp/servers" && post {
        return Ok(success(crate::mcp_servers::upsert(runtime, body).await?));
    }
    if path == "/api/v1/voice/test" && post {
        let voice = runtime
            .voice
            .get()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(ControlError::unavailable)?;
        let text = body["text"].as_str().unwrap_or("这是一条测试播报");
        return Ok(success(
            serde_json::to_value(
                voice
                    .preview(&text.chars().take(200).collect::<String>())
                    .await,
            )
            .map_err(|_| ControlError::unavailable())?,
        ));
    }
    if path == "/api/v1/voice/voices" && get {
        return Ok(success(
            serde_json::to_value(crate::voice::native::voices().await)
                .map_err(|_| ControlError::unavailable())?,
        ));
    }
    if (path == "/api/v1/voice/model" && get)
        || (["/api/v1/voice/model/download", "/api/v1/voice/model/cancel"].contains(&path) && post)
    {
        let models = runtime
            .models
            .get()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(ControlError::unavailable)?;
        let kind = if if get {
            q.get("kind").map(String::as_str)
        } else {
            body["kind"].as_str()
        } == Some("zipvoice")
        {
            "zipvoice"
        } else {
            "kokoro"
        };
        if path.ends_with("/download") {
            models.start(kind).map_err(ControlError::invalid)?;
        } else if path.ends_with("/cancel") {
            models.cancel(kind);
        }
        return Ok(success(models.status(kind)));
    }
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if segments.len() == 5
        && segments[..3] == ["api", "v1", "tools"]
        && segments[4] == "ignored"
        && post
    {
        let ignored = body["ignored"]
            .as_bool()
            .ok_or_else(|| ControlError::invalid("ignored 须为布尔值"))?;
        return Ok(success(
            runtime.set_ignored(&decode(segments[3])?, ignored)?,
        ));
    }
    if segments.len() == 5
        && segments[..3] == ["api", "v1", "tasks"]
        && segments[4] == "state"
        && post
    {
        return Ok(success(runtime.mark_task(&decode(segments[3])?, body)?));
    }
    if segments.len() == 5
        && segments[..3] == ["api", "v1", "tasks"]
        && segments[4] == "undo"
        && post
    {
        return Ok(success(
            runtime.undo_task_mark(&decode(segments[3])?, body)?,
        ));
    }
    if segments.len() == 5
        && segments[..3] == ["api", "v1", "sessions"]
        && segments[4] == "events"
        && post
    {
        let mut body = body.clone();
        body["event"] = body["eventType"].clone();
        return Ok(success(runtime.mark_task(&decode(segments[3])?, &body)?));
    }
    // Clone history before the database lock; mutation paths use the same lock order.
    let history = if path == "/api/v1/board" {
        runtime
            .history
            .lock()
            .map_err(|_| ControlError::unavailable())?
            .clone()
    } else {
        vec![]
    };
    let db = runtime.db.lock().map_err(|_| ControlError::unavailable())?;
    let value = match (method.as_str(), path) {
        ("GET", "/api/v1/mcp/servers") => crate::mcp_servers::list(&db)?,
        ("GET", "/api/v1/tools") => json!(queries::tools(&db, &runtime.manifests, &config)?),
        ("GET", "/api/v1/office") => queries::office(&db, &runtime.manifests, &config)?,
        ("GET", "/api/v1/board") => {
            queries::board(&db, q, &history).map_err(ControlError::invalid)?
        }
        ("GET", "/api/v1/sessions") => control::list_sessions(&db, q)?,
        ("GET", "/api/v1/events") => {
            let records = control::events(&db, q)?;
            if q.get("download").is_some_and(|s| s == "1") {
                let bytes = serde_json::to_vec_pretty(
                    &json!({"exportedAt":queries::now(),"records":records}),
                )
                .map_err(|_| ControlError::unavailable())?;
                let mut response = Response::new(Body::from(bytes));
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    "application/json; charset=utf-8".parse().unwrap(),
                );
                response.headers_mut().insert(
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"awm-events.json\"".parse().unwrap(),
                );
                return Ok(response);
            }
            records
        }
        ("GET", "/api/v1/notifications") => json!(queries::rows(
            &db,
            "SELECT notification_id AS notificationId,ts,title,body,level,read,session_id AS sessionId FROM notifications ORDER BY julianday(ts) DESC,rowid DESC LIMIT ? OFFSET ?",
            vec![
                Sql::Integer(control::limit(q, "limit", 100, 1, 500)? as i64),
                Sql::Integer(control::limit(q, "offset", 0, 0, i64::MAX as usize)? as i64)
            ]
        )?),
        ("POST", "/api/v1/notifications/read") => {
            if let Some(id) = body.get("notificationId") {
                db.execute(
                    "UPDATE notifications SET read=1 WHERE notification_id=?",
                    [id.as_str()
                        .ok_or_else(|| ControlError::invalid("通知编号无效"))?],
                )?;
            } else {
                db.execute("UPDATE notifications SET read=1", [])?;
            }
            json!({"ok":true})
        }
        ("GET", "/api/v1/voice/rules") => control::voice_rules(&db)?,
        ("POST", "/api/v1/voice/rules") => {
            let value = control::set_voice_rule(&db, body)?;
            if let Some(voice) = runtime.voice.get().and_then(std::sync::Weak::upgrade) {
                voice.reconfigure();
            }
            runtime.emit("settings.changed", json!({}));
            value
        }
        _ => {
            if method == Method::DELETE
                && segments.len() == 5
                && segments[..4] == ["api", "v1", "mcp", "servers"]
            {
                db.execute(
                    "DELETE FROM mcp_servers WHERE server_id=?",
                    [decode(segments[4])?],
                )?;
                return Ok(success(json!({"ok":true})));
            }
            if get && segments.len() >= 4 && segments[..3] == ["api", "v1", "sessions"] {
                let id = decode(segments[3])?;
                if segments.len() == 4 {
                    queries::status(&db, &id)?.ok_or_else(|| ControlError::missing("会话不存在"))?
                } else if segments.len() == 5 && segments[4] == "timeline" {
                    json!(queries::timeline(
                        &db,
                        &id,
                        control::limit(q, "limit", 50, 1, 500)?
                    )?)
                } else {
                    return Err(ControlError::missing("未知端点"));
                }
            } else {
                return Err(ControlError::missing("未知端点"));
            }
        }
    };
    Ok(success(value))
}
fn decode(value: &str) -> control::Result<String> {
    let bytes = value.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(ControlError::invalid("路径编码无效"));
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .map_err(|_| ControlError::invalid("路径编码无效"))?;
            out.push(
                u8::from_str_radix(hex, 16).map_err(|_| ControlError::invalid("路径编码无效"))?,
            );
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ControlError::invalid("路径编码无效"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tickets_expire_and_buckets_reset() {
        let mut gate = Gate::default();
        let ticket = gate.ticket();
        gate.tickets
            .insert(ticket.clone(), Instant::now() - Duration::from_secs(1));
        assert!(!gate.consume(Some(&ticket)));
        assert!(!gate.consume(Some(&ticket)));
        for _ in 0..120 {
            assert!(gate.hit("control"));
        }
        assert!(!gate.hit("control"));
        assert!(gate.hit("hooks"));
        gate.buckets
            .insert("control", (Instant::now() - Duration::from_secs(61), 120));
        assert!(gate.hit("control"));
    }
}
