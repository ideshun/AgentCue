use agentcue_runtime::voice::{
    Cancellation,
    backends::Backends,
    models::{Models, Spec},
};
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Notify, watch},
};
#[derive(Clone)]
struct Mock {
    archive: Arc<Vec<u8>>,
    ranges: Arc<Mutex<Vec<Option<String>>>>,
    waiting: Arc<Notify>,
    hang: bool,
}
async fn serve(State(mock): State<Mock>, headers: HeaderMap) -> Response {
    let range = headers
        .get("range")
        .and_then(|s| s.to_str().ok())
        .map(str::to_owned);
    mock.ranges.lock().unwrap().push(range.clone());
    mock.waiting.notify_one();
    if mock.hang {
        return (
            StatusCode::OK,
            Body::from_stream(futures_util::stream::pending::<
                Result<Vec<u8>, std::io::Error>,
            >()),
        )
            .into_response();
    }
    if let Some(range) = range {
        let start: usize = range
            .trim_start_matches("bytes=")
            .trim_end_matches('-')
            .parse()
            .unwrap();
        return (
            StatusCode::PARTIAL_CONTENT,
            [(
                "content-range",
                format!(
                    "bytes {start}-{}/{}",
                    mock.archive.len() - 1,
                    mock.archive.len()
                ),
            )],
            mock.archive[start..].to_vec(),
        )
            .into_response();
    }
    mock.archive.as_ref().clone().into_response()
}
async fn ready(manager: &Models) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = manager.status("kokoro");
            if value["state"] != "downloading" && value["state"] != "extracting" {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
fn dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("agentcue-model-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}
#[tokio::test]
async fn explicit_download_resumes_and_validates_before_installing() {
    let root = dir();
    let source = root.join("source/fixture-model");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("model.onnx"), b"fixture model only").unwrap();
    let archive = root.join("fixture.tar.bz2");
    assert!(
        std::process::Command::new("tar")
            .arg("-cjf")
            .arg(&archive)
            .arg("-C")
            .arg(source.parent().unwrap())
            .arg("fixture-model")
            .status()
            .unwrap()
            .success()
    );
    let mock = Mock {
        archive: Arc::new(fs::read(&archive).unwrap()),
        ranges: Arc::new(Mutex::new(vec![])),
        waiting: Arc::new(Notify::new()),
        hang: false,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = Router::new().fallback(serve).with_state(mock.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let spec:Spec=serde_json::from_value(json!({"kind":"kokoro","dirName":"fixture-model","archiveUrl":format!("http://127.0.0.1:{port}/model"),"requiredFiles":[{"name":"model.onnx","minBytes":10}]})).unwrap();
    let models = root.join("models");
    fs::create_dir_all(&models).unwrap();
    fs::write(
        models.join("fixture-model.tar.bz2.part"),
        &mock.archive[..10],
    )
    .unwrap();
    let manager = Models::new(models.clone(), Weak::new(), vec![spec]);
    assert_eq!(manager.status("kokoro")["state"], "missing");
    assert!(mock.ranges.lock().unwrap().is_empty());
    manager.start("kokoro").unwrap();
    let status = ready(&manager).await;
    assert_eq!(status["state"], "ready", "{status}");
    assert_eq!(
        fs::read(models.join("fixture-model/model.onnx")).unwrap(),
        b"fixture model only"
    );
    assert_eq!(mock.ranges.lock().unwrap()[0], Some("bytes=10-".into()));
    manager.start("kokoro").unwrap();
    assert_eq!(mock.ranges.lock().unwrap().len(), 1);
    manager.close().await;
    server.abort();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn cancellation_closes_a_stalled_download_and_does_not_report_ready() {
    let root = dir();
    let mock = Mock {
        archive: Arc::new(vec![]),
        ranges: Arc::new(Mutex::new(vec![])),
        waiting: Arc::new(Notify::new()),
        hang: true,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = Router::new().fallback(serve).with_state(mock.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let spec:Spec=serde_json::from_value(json!({"kind":"kokoro","dirName":"fixture-model","archiveUrl":format!("http://127.0.0.1:{port}/model"),"requiredFiles":[{"name":"model.onnx","minBytes":10}]})).unwrap();
    let manager = Models::new(root.join("models"), Weak::new(), vec![spec]);
    manager.start("kokoro").unwrap();
    tokio::time::timeout(Duration::from_secs(2), mock.waiting.notified())
        .await
        .unwrap();
    manager.cancel("kokoro");
    assert_eq!(ready(&manager).await["state"], "missing");
    manager.close().await;
    assert!(!root.join("models/fixture-model").exists());
    server.abort();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn unavailable_selected_backend_never_falls_back_to_system_voice() {
    let root = dir();
    let manager = Models::new(
        root.join("models"),
        Weak::new(),
        agentcue_runtime::voice::models::specs(),
    );
    let backends = Backends::new(manager.clone(), root.join("missing-worker"));
    let (keep, receiver) = watch::channel(0);
    let config = json!({"voice":{"backend":"local","localEngine":"kokoro","voiceProfile":"kokoro:4","rate":1.0,"volume":0.4}});
    let result = backends
        .speak(
            &config,
            "合成测试".into(),
            Cancellation {
                receiver,
                generation: 0,
            },
        )
        .await;
    assert!(!result.ok);
    assert!(result.used_backend.is_none());
    assert!(result.errors[0].starts_with("local："));
    drop(keep);
    manager.close().await;
    fs::remove_dir_all(root).unwrap();
}
