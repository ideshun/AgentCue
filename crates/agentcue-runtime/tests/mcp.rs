use agentcue_runtime::{
    mcp::{self, ControlClient, Server},
    paths,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
fn init() -> Value {
    json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":mcp::PROTOCOL,"capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}})
}
fn absolute_fixture_path(path: &str) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(format!("C:\\{}", path.replace('/', "\\")))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(format!("/{path}"))
    }
}
#[tokio::test]
async fn lifecycle_schema_and_notifications_are_enforced() {
    let client =
        ControlClient::new(std::env::temp_dir().join(format!("missing-{}", uuid::Uuid::new_v4())))
            .unwrap();
    let mut s = Server::default();
    let early = s
        .handle(
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            &client,
        )
        .await
        .unwrap();
    assert_eq!(early["error"]["code"], -32002);
    let ready = s.handle(init(), &client).await.unwrap();
    assert_eq!(ready["id"], "init");
    assert_eq!(ready["result"]["protocolVersion"], mcp::PROTOCOL);
    assert!(
        s.handle(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            &client
        )
        .await
        .is_none()
    );
    let list = s
        .handle(
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            &client,
        )
        .await
        .unwrap();
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 6);
    for args in [
        json!({"limit":"10"}),
        json!({"limit":201}),
        json!({"state":"unknown"}),
        json!({"extra":true}),
    ] {
        let r=s.handle(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_sessions","arguments":args}}),&client).await.unwrap();
        assert_eq!(r["error"]["code"], -32602);
    }
    let unavailable = s
        .handle(
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_tools"}}),
            &client,
        )
        .await
        .unwrap();
    assert_eq!(unavailable["result"]["isError"], true);
    let body: Value = serde_json::from_str(
        unavailable["result"]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["error"]["code"], "ENGINE_UNAVAILABLE");
    assert!(
        s.handle(json!({"jsonrpc":"2.0","method":"unknown"}), &client)
            .await
            .is_none()
    );
    assert_eq!(
        s.handle(json!([]), &client).await.unwrap()["error"]["code"],
        -32600
    );
}
#[tokio::test]
async fn stdio_framing_recovers_from_bad_json_and_limits_unterminated_input() {
    let input = b"{bad}\n{\"jsonrpc\":\"2.0\",\"method\":\"ping\",\"id\":7}\n";
    let (mut reader, writer) = tokio::io::duplex(4096);
    mcp::run_stdio(
        input.as_slice(),
        writer,
        std::env::temp_dir().join("agentcue-missing-test"),
    )
    .await
    .unwrap();
    let mut output = String::new();
    reader.read_to_string(&mut output).await.unwrap();
    let lines: Vec<Value> = output
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["error"]["code"], -32700);
    assert_eq!(lines[1]["id"], 7);
    let mut oversized = BufReader::new(b"123456789".as_slice());
    assert!(mcp::read_line(&mut oversized, 8).await.is_err());
    let (mut input, read) = tokio::io::duplex(64);
    input.write_all(b"1\r\n2").await.unwrap();
    drop(input);
    let mut read = BufReader::new(read);
    assert_eq!(
        mcp::read_line(&mut read, 8).await.unwrap().unwrap(),
        b"1\r\n"
    );
    assert_eq!(mcp::read_line(&mut read, 8).await.unwrap().unwrap(), b"2");
    assert!(mcp::read_line(&mut read, 8).await.unwrap().is_none());
}
#[test]
fn app_paths_follow_each_platform_convention() {
    let home = absolute_fixture_path("fixture");
    assert_eq!(
        paths::app_paths("macos", &home, None, None, None, None),
        paths::AppPaths {
            data_dir: home.join("Library/Application Support/AgentCue"),
            config_dir: home.join("Library/Application Support/AgentCue"),
            legacy_data_dir: Some(home.join("Library/Application Support/AI Workflow Monitor")),
        }
    );
    assert_eq!(
        paths::app_paths("windows", &home, None, None, None, None),
        paths::AppPaths {
            data_dir: home.join("AppData/Local/AgentCue"),
            config_dir: home.join("AppData/Local/AgentCue"),
            legacy_data_dir: Some(home.join("AppData/Roaming/AI Workflow Monitor")),
        }
    );
    assert_eq!(
        paths::app_paths(
            "windows",
            &home,
            Some(&absolute_fixture_path("local")),
            Some(&absolute_fixture_path("roaming")),
            None,
            None,
        ),
        paths::AppPaths {
            data_dir: absolute_fixture_path("local/AgentCue"),
            config_dir: absolute_fixture_path("local/AgentCue"),
            legacy_data_dir: Some(absolute_fixture_path("roaming/AI Workflow Monitor")),
        }
    );
    assert_eq!(
        paths::app_paths(
            "linux",
            &home,
            None,
            None,
            None,
            Some(&absolute_fixture_path("config")),
        ),
        paths::AppPaths {
            data_dir: home.join(".local/share/agentcue"),
            config_dir: absolute_fixture_path("config/agentcue"),
            legacy_data_dir: Some(absolute_fixture_path("config/AI Workflow Monitor")),
        }
    );
    assert_eq!(
        paths::app_paths(
            "linux",
            &home,
            None,
            None,
            Some(&absolute_fixture_path("data")),
            Some(Path::new("relative-config")),
        ),
        paths::AppPaths {
            data_dir: absolute_fixture_path("data/agentcue"),
            config_dir: home.join(".config/agentcue"),
            legacy_data_dir: Some(home.join(".config/AI Workflow Monitor")),
        }
    );
}
