use agentcue_runtime::mcp_client::{self, Config, Options};
use axum::{
    Router,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::time::Duration;
use tokio::{net::TcpListener, sync::oneshot};
#[derive(Clone)]
struct HttpState {
    seen: Arc<Mutex<Vec<Value>>>,
    sse: bool,
    wrong_id: bool,
}
async fn mock(
    State(s): State<HttpState>,
    method: Method,
    headers: HeaderMap,
    body: String,
) -> Response {
    if method == Method::DELETE {
        s.seen.lock().unwrap().push(json!({"method":"DELETE","session":headers.get("mcp-session-id").unwrap().to_str().unwrap()}));
        return StatusCode::NO_CONTENT.into_response();
    }
    let value: Value = serde_json::from_str(&body).unwrap();
    s.seen.lock().unwrap().push(json!({"payload":value,"protocol":headers.get("mcp-protocol-version").and_then(|v|v.to_str().ok()),"session":headers.get("mcp-session-id").and_then(|v|v.to_str().ok())}));
    if value["method"] == "notifications/initialized" {
        return StatusCode::ACCEPTED.into_response();
    }
    let id = if s.wrong_id {
        json!("wrong")
    } else {
        value["id"].clone()
    };
    let result = if value["method"] == "initialize" {
        json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
    } else if value["params"].get("cursor").is_none() {
        json!({"tools":[{"name":"first","description":"合成工具"}],"nextCursor":"page2"})
    } else {
        assert_eq!(value["params"]["cursor"], "page2");
        json!({"tools":[{"name":"second"}]})
    };
    let rpc = json!({"jsonrpc":"2.0","id":id,"result":result});
    let mut response = if s.sse {
        let text = format!(
            "event: message\r\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{{}}}}\r\n\r\nevent: message\r\ndata: {rpc}\r\n\r\n"
        );
        ([("content-type", "text/event-stream")], text).into_response()
    } else {
        axum::Json(rpc).into_response()
    };
    response
        .headers_mut()
        .insert("mcp-session-id", "fixture-session".parse().unwrap());
    response
}
#[tokio::test]
async fn http_negotiates_headers_paginates_json_and_sse_and_deletes_session() {
    for sse in [false, true] {
        let state = HttpState {
            seen: Arc::new(Mutex::new(vec![])),
            sse,
            wrong_id: false,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, stopped) = oneshot::channel();
        let router = Router::new().fallback(mock).with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap()
        });
        let result = mcp_client::validate(
            Config::Http {
                url: format!("http://127.0.0.1:{port}/mcp"),
            },
            Options::default(),
        )
        .await;
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["status"], "disconnected");
        assert_eq!(result["tools"].as_array().unwrap().len(), 2);
        let seen = state.seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 5);
        assert_eq!(seen[1]["protocol"], "2025-06-18");
        assert_eq!(seen[1]["session"], "fixture-session");
        assert_eq!(seen[4]["method"], "DELETE");
        stop.send(()).unwrap();
        task.await.unwrap();
    }
}
#[tokio::test]
async fn http_wrong_id_fails_without_fake_verified_status() {
    let state = HttpState {
        seen: Arc::new(Mutex::new(vec![])),
        sse: false,
        wrong_id: true,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        axum::serve(listener, Router::new().fallback(mock).with_state(state))
            .await
            .unwrap()
    });
    let result = mcp_client::validate(
        Config::Http {
            url: format!("http://127.0.0.1:{port}"),
        },
        Options::default(),
    )
    .await;
    assert_eq!(result["ok"], false);
    assert!(result["lastError"].as_str().unwrap().contains("id 不匹配"));
    assert_eq!(result["tools"], json!([]));
    task.abort();
}
#[cfg(unix)]
async fn python(script: &str, timeout_ms: u64, max_bytes: usize) -> Value {
    mcp_client::validate(
        Config::Stdio {
            command: "/usr/bin/python3".into(),
            args: vec!["-u".into(), "-c".into(), script.into()],
        },
        Options {
            timeout: Duration::from_millis(timeout_ms),
            max_bytes,
        },
    )
    .await
}
#[cfg(unix)]
#[tokio::test]
async fn stdio_protocol_faults_limits_timeouts_and_process_exit_are_errors() {
    let valid = r#"
import sys,json
for line in sys.stdin:
 p=json.loads(line)
 if p.get('method')=='notifications/initialized': continue
 r={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}} if p['method']=='initialize' else {'tools':[{'name':'fixture_tool'}]}
 print(json.dumps({'jsonrpc':'2.0','id':p['id'],'result':r}),flush=True)
"#;
    let good = python(valid, 10_000, 1024 * 1024).await;
    assert_eq!(good["ok"], true, "{good}");
    assert_eq!(good["tools"][0]["name"], "fixture_tool");
    let bad = python("print('not JSON',flush=True)", 10_000, 1024).await;
    assert_eq!(bad["ok"], false);
    assert!(bad["lastError"].as_str().unwrap().contains("非 JSON"));
    let oversized = python("print('x'*4096,flush=True)", 10_000, 1024).await;
    assert_eq!(oversized["ok"], false);
    assert!(oversized["lastError"].as_str().unwrap().contains("上限"));
    let timeout = python("import time;time.sleep(60)", 50, 1024).await;
    assert_eq!(timeout["ok"], false);
    assert_eq!(timeout["lastError"], "MCP 验证超时");
    let wrong = python(&valid.replace("'id':p['id']", "'id':999"), 10_000, 1024).await;
    assert!(wrong["lastError"].as_str().unwrap().contains("id 不匹配"));
    let exited = python("import sys;sys.exit(1)", 10_000, 1024).await;
    assert_eq!(exited["ok"], false);
    assert!(exited["lastError"].as_str().unwrap().contains("提前退出"));
}
