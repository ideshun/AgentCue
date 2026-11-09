use agentcue_runtime::voice::backends::synthesize_cloud;
use axum::{Router, extract::State, http::HeaderMap};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
async fn mock(
    State(seen): State<Arc<Mutex<Vec<Value>>>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> axum::Json<Value> {
    assert_eq!(headers["authorization"], "Bearer synthetic-key");
    seen.lock().unwrap().push(body);
    let mut wav = b"RIFF".to_vec();
    wav.extend_from_slice(&38_u32.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&24000_u32.to_le_bytes());
    wav.extend_from_slice(&48000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&2_u32.to_le_bytes());
    wav.extend_from_slice(&1000_i16.to_le_bytes());
    axum::Json(json!({"choices":[{"message":{"audio":{"data":STANDARD.encode(wav)}}}]}))
}
#[tokio::test]
async fn cloud_requires_selection_opt_in_and_key_before_sending_text() {
    let seen = Arc::new(Mutex::new(vec![]));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = Router::new().fallback(mock).with_state(seen.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut config = json!({"voice":{"backend":"native","cloudEnabled":false,"cloudApiKey":"synthetic-key","cloudEndpoint":format!("http://127.0.0.1:{port}/v1/chat/completions")}});
    assert!(synthesize_cloud(&config, "合成测试").await.is_err());
    config["voice"]["backend"] = json!("cloud");
    assert!(synthesize_cloud(&config, "合成测试").await.is_err());
    assert!(seen.lock().unwrap().is_empty());
    config["voice"]["cloudEnabled"] = json!(true);
    let audio = synthesize_cloud(&config, "合成测试").await.unwrap();
    assert_eq!(&audio[..4], b"RIFF");
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["model"], "mimo-v2.5-tts");
    assert_eq!(requests[0]["messages"][1]["content"], "合成测试");
    drop(requests);
    server.abort();
}
