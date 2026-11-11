use crate::services::Services;
use agentcue_runtime::{
    mcp_client::{self, Config, Options},
    paths::AppPaths,
    queries,
};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio};
use tokio::{io::AsyncWriteExt, process::Command};

pub async fn run() -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("agentcue-self-test-{}", uuid::Uuid::new_v4()));
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let services = Services::start(
        AppPaths::for_data_dir(dir.clone()),
        executable.clone(),
        true,
    )
    .await?;
    let result = verify(&services, &executable).await;
    services.close().await;
    drop(services);
    let _ = std::fs::remove_dir_all(dir);
    result?;
    println!(
        "AgentCue {} native self-test passed",
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}

async fn verify(services: &Services, executable: &Path) -> Result<(), String> {
    let runtime = &services.runtime;
    runtime
        .update_settings(&json!({"voice":{"enabled":false},"quiet":{"globalMute":true}}))
        .map_err(|e| e.to_string())?;
    let source = runtime
        .data_dir
        .join("fixture-home/.codex/sessions/fixture/source.jsonl");
    std::fs::create_dir_all(source.parent().unwrap()).map_err(|e| e.to_string())?;
    let stamp = queries::now();
    let start = json!({"timestamp":stamp,"type":"event_msg","payload":{"type":"task_started","turn_id":"fixture"}});
    let end = json!({"timestamp":stamp,"type":"event_msg","payload":{"type":"task_complete","turn_id":"fixture"}});
    std::fs::write(&source, format!("{start}\n{end}\n")).map_err(|e| e.to_string())?;
    if services.monitor.capture().await? != 2 || services.monitor.capture().await? != 0 {
        return Err("采集未保持增量与去重语义".into());
    }

    let mut child = Command::new(executable)
        .args(["--tool-hook", "cursor", "--data-dir"])
        .arg(&runtime.data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let payload = json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"fixture","generation_id":"native-hook","prompt":"合成任务"});
    child
        .stdin
        .take()
        .ok_or("Hook 输入管道不可用")?
        .write_all(payload.to_string().as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output())
        .await
        .map_err(|_| "Hook 入口超时")?
        .map_err(|e| e.to_string())?;
    let acknowledgment: Value =
        serde_json::from_slice(&result.stdout).map_err(|_| "Hook 放行应答无效")?;
    if !result.status.success() || acknowledgment != json!({"continue":true}) {
        return Err("Hook 放行应答无效".into());
    }

    let bridge = mcp_client::validate(
        Config::Stdio {
            command: executable.to_string_lossy().into_owned(),
            args: vec![
                "--mcp-stdio".into(),
                "--data-dir".into(),
                runtime.data_dir.to_string_lossy().into_owned(),
            ],
        },
        Options::default(),
    )
    .await;
    if bridge["ok"] != true || bridge["tools"].as_array().map(Vec::len) != Some(6) {
        return Err("MCP 入口未返回完整工具列表".into());
    }

    let client = agentcue_runtime::mcp::ControlClient::new(runtime.data_dir.clone())
        .map_err(|e| e.to_string())?;
    let sessions = client.invoke("list_sessions", &json!({})).await;
    if sessions["success"] != true || sessions["data"].as_array().map(Vec::len) != Some(2) {
        return Err("控制 API 未读回两条合成会话".into());
    }
    let worker = executable.with_file_name(if cfg!(windows) {
        "agentcue-tts.exe"
    } else {
        "agentcue-tts"
    });
    let mut child = Command::new(worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "语音工作进程缺失或无法启动")?;
    child
        .stdin
        .take()
        .ok_or("语音输入管道不可用")?
        .write_all(b"{\"id\":1}\n")
        .await
        .map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output())
        .await
        .map_err(|_| "语音工作进程超时")?
        .map_err(|e| e.to_string())?;
    let response: Value =
        serde_json::from_slice(&result.stdout).map_err(|_| "语音工作进程应答无效")?;
    if !result.status.success() || response["id"] != 1 || response["ok"] != false {
        return Err("语音工作进程未正确拒绝无效请求".into());
    }
    Ok(())
}
