//! Lightweight observer entry. Failures always return a native allow response, never raw input or errors.
use crate::{paths, queries};
use agentcue_adapters::hooks;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub async fn run<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    input: R,
    mut output: W,
    tool: &str,
    explicit: Option<&str>,
    data_dir: &Path,
) {
    let mut phase = explicit.map(str::to_owned);
    let received = queries::now();
    let work = async {
        let mut bytes = vec![];
        input
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| ())?;
        if bytes.len() > 1024 * 1024 {
            return Err(());
        }
        let raw: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if phase.is_none() {
            phase = raw["hook_event_name"].as_str().map(str::to_owned);
        }
        let events = hooks::normalize(tool, &raw, explicit, &received).map_err(|_| ())?;
        if events.is_empty() {
            return Ok(());
        }
        let runtime = paths::read_runtime(data_dir).map_err(|_| ())?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ())?;
        for event in events {
            let mode = hooks::mode(&event);
            let body = json!({"mode":mode,"event":event});
            for attempt in 0..3 {
                let response = client
                    .post(format!(
                        "http://127.0.0.1:{}/api/v1/integrations/hooks",
                        runtime.api_port
                    ))
                    .bearer_auth(&runtime.token)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|_| ())?;
                let status = response.status();
                drop(response);
                if status.is_success() {
                    break;
                }
                if !(status.as_u16() == 429 || status.is_server_error()) || attempt == 2 {
                    return Err(());
                }
                tokio::time::sleep(Duration::from_millis((attempt + 1) * 120)).await;
            }
        }
        Ok::<(), ()>(())
    };
    let _ = tokio::time::timeout(Duration::from_millis(1750), work).await;
    let acknowledgment = format!("{}\n", hooks::acknowledgment(tool, phase.as_deref()));
    let _ = tokio::time::timeout(Duration::from_millis(20), async {
        output.write_all(acknowledgment.as_bytes()).await?;
        output.flush().await
    })
    .await;
}
