use agentcue_runtime::{api, state::Runtime};
use agentcue_store::{engine::Event, migrate};
use futures_util::StreamExt;
use reqwest::{Client, Response};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
struct Fixture {
    dir: PathBuf,
    runtime: Arc<Runtime>,
    handle: api::ApiHandle,
    client: Client,
    receiver: tokio::sync::mpsc::Receiver<Event>,
}
impl Fixture {
    async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("agentcue-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("AgentCue's executable");
        std::fs::write(&exe, "").unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&mut db).unwrap();
        let (runtime, receiver) = Runtime::new(db, &dir, exe).unwrap();
        let handle = api::start(runtime.clone(), 0).await.unwrap();
        Self {
            dir,
            runtime,
            handle,
            receiver,
            client: Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
        }
    }
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.handle.port)
    }
    async fn get(&self, path: &str) -> Response {
        self.client
            .get(self.url(path))
            .bearer_auth(&self.handle.token)
            .send()
            .await
            .unwrap()
    }
    async fn post(&self, path: &str, body: Value) -> Response {
        self.client
            .post(self.url(path))
            .bearer_auth(&self.handle.token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn close(self) {
        self.handle.close().await.unwrap();
        std::fs::remove_dir_all(self.dir).unwrap();
    }
    async fn event(&self, kind: &str, id: &str) {
        self.runtime
            .ingest(
                &[Event {
                    event_id: format!("evt_{id}"),
                    session_id: "fixture-task".into(),
                    tool_id: "codex".into(),
                    event_type: kind.into(),
                    occurred_at: agentcue_runtime::queries::now(),
                    actor: "tool".into(),
                    payload: serde_json::from_value(json!({"taskTitle":"合成任务"})).unwrap(),
                    schema_version: 1,
                }],
                None,
                false,
            )
            .await
            .unwrap();
    }
}
#[tokio::test]
async fn notification_pages_filter_before_paging_and_keep_a_stable_cursor() {
    let f = Fixture::new().await;
    let insert = |db: &Connection, id: &str, level: &str| {
        db.execute(
            "INSERT INTO notifications (notification_id, ts, title, body, level) VALUES (?1, '2026-01-01T00:00:00Z', 'Synthetic', 'Synthetic', ?2)",
            [id, level],
        ).unwrap();
    };
    {
        let db = f.runtime.db.lock().unwrap();
        insert(&db, "old-attention", "attention");
        for index in 0..101 {
            insert(&db, &format!("info-{index}"), "info");
        }
    }
    let path = "/api/v1/notifications/page";
    let filtered: Value = f
        .get(&format!("{path}?level=attention"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        filtered["data"]["items"][0]["notificationId"],
        "old-attention"
    );
    assert_eq!(filtered["data"]["totalUnread"], 102);
    assert_eq!(filtered["data"]["unread"], 1);
    assert_eq!(filtered["data"]["hasMore"], false);

    let first: Value = f
        .get(&format!("{path}?limit=100"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(first["data"]["hasMore"], true);
    let before = first["data"]["items"][99]["notificationId"]
        .as_str()
        .unwrap();
    insert(&f.runtime.db.lock().unwrap(), "new-info", "info");
    let next: Value = f
        .get(&format!("{path}?limit=100&before={before}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(next["data"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(next["data"]["items"][0]["notificationId"], "info-0");
    assert_eq!(next["data"]["items"][1]["notificationId"], "old-attention");
    assert_eq!(next["data"]["hasMore"], false);
    assert!(
        f.post("/api/v1/notifications/read", json!({"level":"attention"}))
            .await
            .status()
            .is_success()
    );
    let read: Value = f
        .get(&format!("{path}?level=attention"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["data"]["totalUnread"], 102);
    assert_eq!(read["data"]["unread"], 0);
    assert_eq!(f.get(&format!("{path}?level=invalid")).await.status(), 400);
    f.close().await;
}

#[tokio::test]
async fn authentication_cors_and_json_errors_are_explicit() {
    let f = Fixture::new().await;
    assert_eq!(
        f.client
            .get(f.url("/api/v1/health"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        f.client
            .get(f.url("/api/v1/health"))
            .bearer_auth(format!("{}x", f.handle.token))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let preflight = f
        .client
        .request(reqwest::Method::OPTIONS, f.url("/api/v1/settings"))
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), 204);
    assert_eq!(preflight.headers()["access-control-allow-origin"], "*");
    let health: Value = f.get("/api/v1/health").await.json().await.unwrap();
    assert_eq!(health["ok"], true);
    let bad = f
        .client
        .put(f.url("/api/v1/settings"))
        .bearer_auth(&f.handle.token)
        .body("{broken}")
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
    assert_eq!(
        bad.json::<Value>().await.unwrap()["error"]["code"],
        "INVALID_PARAM"
    );
    assert_eq!(
        f.post("/api/v1/notifications/read", json!([]))
            .await
            .status(),
        400
    );
    let invalid = f
        .client
        .put(f.url("/api/v1/settings"))
        .bearer_auth(&f.handle.token)
        .json(&json!({"voice":{"rate":"1.0"}}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), 400);
    let audit = {
        let db = f.runtime.db.lock().unwrap();
        agentcue_runtime::queries::rows(&db, "SELECT action,result FROM audit_log", vec![]).unwrap()
    };
    assert!(
        !serde_json::to_string(&audit)
            .unwrap()
            .contains(&f.handle.token)
    );
    assert!(
        audit
            .iter()
            .all(|row| !row["action"].as_str().unwrap_or("").starts_with("GET "))
    );
    f.close().await;
}
#[tokio::test]
async fn board_actions_keep_whitelist_and_illegal_edges_distinct() {
    let f = Fixture::new().await;
    f.event("task.started", "start").await;
    f.event("task.waiting_human", "wait").await;
    let board: Value = f.get("/api/v1/board").await.json().await.unwrap();
    assert_eq!(board["data"]["groups"][0]["total"], 1);
    assert_eq!(
        f.post(
            "/api/v1/tasks/fixture-task/state",
            json!({"event":"task.completed"})
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        f.post(
            "/api/v1/tasks/missing/state",
            json!({"event":"human.responded"})
        )
        .await
        .status(),
        404
    );
    let resumed = f
        .post(
            "/api/v1/tasks/fixture-task/state",
            json!({"event":"human.responded"}),
        )
        .await;
    assert_eq!(resumed.status(), 200);
    assert_eq!(
        resumed.json::<Value>().await.unwrap()["data"]["nextState"],
        "running"
    );
    let illegal = f
        .post(
            "/api/v1/tasks/fixture-task/state",
            json!({"event":"human.responded"}),
        )
        .await;
    assert_eq!(illegal.status(), 409);
    assert_eq!(
        illegal.json::<Value>().await.unwrap()["error"]["code"],
        "ILLEGAL_TRANSITION"
    );
    let status: Value = f
        .get("/api/v1/sessions/fixture-task")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(status["data"]["recent"].as_array().unwrap().len(), 3);
    let overview: Value = f.get("/api/v1/overview").await.json().await.unwrap();
    assert_eq!(overview["data"]["attention"], 0);
    assert_eq!(f.get("/api/v1/sessions?state=made-up").await.status(), 400);
    assert_eq!(f.get("/api/v1/sessions?limit=201").await.status(), 400);
    assert_eq!(f.get("/api/v1/events?from=invalid").await.status(), 400);
    f.close().await;
}
#[tokio::test]
async fn stream_tickets_are_single_use_and_shutdown_closes_connections() {
    let f = Fixture::new().await;
    let ticket: Value = f
        .post("/api/v1/stream-ticket", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let path = format!(
        "/api/v1/stream?ticket={}",
        ticket["data"]["ticket"].as_str().unwrap()
    );
    let response = f.client.get(f.url(&path)).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        f.client.get(f.url(&path)).send().await.unwrap().status(),
        401
    );
    let mut stream = response.bytes_stream();
    f.runtime.emit("board.updated", json!({"fixture":true}));
    let mut saw = false;
    for _ in 0..3 {
        let chunk = stream.next().await.unwrap().unwrap();
        if String::from_utf8_lossy(&chunk).contains("fixture") {
            saw = true;
            break;
        }
    }
    assert!(saw);
    for i in 0..300 {
        f.runtime.emit("board.updated", json!({"seq": i}));
    }
    let mut saw_resync = false;
    for _ in 0..10 {
        let chunk = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if String::from_utf8_lossy(&chunk).contains("stream.resync") {
            saw_resync = true;
            break;
        }
    }
    assert!(saw_resync, "lagged SSE stream should emit stream.resync");
    f.handle.close().await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(Ok(_)) = stream.next().await {}
    })
    .await;
    assert!(
        closed.is_ok(),
        "server shutdown did not close the SSE stream"
    );
    std::fs::remove_dir_all(f.dir).unwrap();
}
#[tokio::test]
async fn hook_and_control_rate_buckets_are_independent() {
    let f = Fixture::new().await;
    for _ in 0..120 {
        assert_eq!(
            f.post("/api/v1/integrations/hooks", json!({}))
                .await
                .status(),
            400
        );
    }
    assert_eq!(
        f.post("/api/v1/integrations/hooks", json!({}))
            .await
            .status(),
        429
    );
    assert_eq!(f.get("/api/v1/health").await.status(), 200);
    f.close().await;
}
#[tokio::test]
async fn integration_paths_are_real_and_shell_quoted() {
    let f = Fixture::new().await;
    let snippets: Value = f.get("/api/v1/mcp/snippets").await.json().await.unwrap();
    for snippet in snippets["data"].as_array().unwrap() {
        let content = snippet["json"].as_str().unwrap();
        assert!(!content.contains("__AGENTCUE_EXECUTABLE__"));
        if snippet["format"] == "json" {
            let parsed: Value = serde_json::from_str(content).unwrap();
            let command = if snippet["id"] == "opencode" {
                &parsed["mcp"]["servers"]["ai-workflow-monitor"]["command"][0]
            } else {
                &parsed
                    .get("mcpServers")
                    .or_else(|| parsed.get("servers"))
                    .unwrap()["ai-workflow-monitor"]["command"]
            };
            assert_eq!(command, &json!(f.runtime.executable));
        }
    }
    let hooks: Value = f
        .get("/api/v1/integrations/hooks")
        .await
        .json()
        .await
        .unwrap();
    let content: Value =
        serde_json::from_str(hooks["data"][0]["files"][0]["content"].as_str().unwrap()).unwrap();
    // Assert decoded shell commands; JSON serialization escapes backslashes separately.
    let command = content["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    assert!(command.contains("'\\''"));
    if cfg!(windows) {
        assert_eq!(
            content["hooks"]["UserPromptSubmit"][0]["hooks"][0]["shell"],
            "bash"
        );
    }
    assert_eq!(
        f.post("/api/v1/tools/codex/ignored", json!({"ignored":true}))
            .await
            .status(),
        200
    );
    f.event("task.started", "disabled").await;
    let sessions: Value = f.get("/api/v1/sessions").await.json().await.unwrap();
    assert_eq!(sessions["data"].as_array().unwrap().len(), 0);
    f.close().await;
}

#[tokio::test]
async fn hook_cli_and_mcp_bridge_reach_the_same_live_control_service() {
    let mut f = Fixture::new().await;
    agentcue_runtime::paths::write_runtime(
        &f.dir,
        &agentcue_runtime::paths::RuntimeInfo {
            api_port: f.handle.port,
            token: f.handle.token.clone(),
            pid: std::process::id(),
            started_at: agentcue_runtime::queries::now(),
        },
    )
    .unwrap();
    let input=json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"fixture","generation_id":"cli","prompt":"合成任务"}).to_string();
    let (mut reader, writer) = tokio::io::duplex(4096);
    agentcue_runtime::hook_cli::run(input.as_bytes(), writer, "cursor", None, &f.dir).await;
    use tokio::io::AsyncReadExt;
    let mut output = String::new();
    reader.read_to_string(&mut output).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&output).unwrap(),
        json!({"continue":true})
    );
    assert_eq!(f.receiver.try_recv().unwrap().event_type, "task.started");
    let client = agentcue_runtime::mcp::ControlClient::new(f.dir.clone()).unwrap();
    let result = client
        .invoke("list_sessions", &json!({"toolId":"cursor"}))
        .await;
    assert_eq!(result["success"], true);
    assert_eq!(result["data"].as_array().unwrap().len(), 1);
    assert_eq!(result["data"][0]["currentState"], "running");
    f.close().await;
}
