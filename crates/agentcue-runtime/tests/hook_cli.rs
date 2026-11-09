use agentcue_runtime::hook_cli;
use serde_json::Value;
use tokio::io::AsyncReadExt;
#[tokio::test]
async fn observer_always_returns_native_allow_fields_without_echoing_input() {
    let dir = std::env::temp_dir().join(format!("missing-hooks-{}", uuid::Uuid::new_v4()));
    for (tool, phase, expected) in [
        (
            "cursor",
            Some("beforeSubmitPrompt"),
            serde_json::json!({"continue":true}),
        ),
        ("cline", None, serde_json::json!({"cancel":false})),
        (
            "codebuddy",
            None,
            serde_json::json!({"continue":true,"suppressOutput":true}),
        ),
        ("claude-code", None, serde_json::json!({})),
    ] {
        let (mut reader, writer) = tokio::io::duplex(2048);
        hook_cli::run(
            b"{invalid secret private input}".as_slice(),
            writer,
            tool,
            phase,
            &dir,
        )
        .await;
        let mut output = String::new();
        reader.read_to_string(&mut output).await.unwrap();
        let actual: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(actual, expected);
        assert!(!output.contains("private"));
    }
}
#[tokio::test]
async fn input_larger_than_the_limit_is_rejected_without_blocking_the_editor() {
    let input = vec![b'x'; 1024 * 1024 + 2];
    let (mut reader, writer) = tokio::io::duplex(2048);
    hook_cli::run(
        input.as_slice(),
        writer,
        "cline",
        None,
        &std::env::temp_dir().join("missing-agentcue-hook-runtime"),
    )
    .await;
    let mut output = String::new();
    reader.read_to_string(&mut output).await.unwrap();
    assert_eq!(output.trim(), "{\"cancel\":false}");
}
