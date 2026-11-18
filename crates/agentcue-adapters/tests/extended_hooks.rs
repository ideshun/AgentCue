use agentcue_adapters::hooks::{mode, normalize, parse};
use serde_json::json;
const TIME: &str = "2026-11-17T00:00:00.000Z";
#[test]
fn deepseek_observes_committed_outcomes_and_preserves_turn_identity() {
    for (reason, expected) in [
        ("completed", "task.completed"),
        ("aborted", "task.cancelled"),
        ("error", "task.failed"),
        ("max-tokens", "task.failed"),
    ] {
        let input = json!({"session_id":"dsh-fixture","hook_event_name":"turn/end","turn":2,"reason":{"kind":reason},"event_id":"12","occurred_at":TIME});
        let e = normalize("deepseek-harness", &input, None, TIME)
            .unwrap()
            .remove(0);
        assert_eq!(e.event_type, expected);
        assert!(e.session_id.ends_with(":turn:2"));
        assert!(parse(&json!({"mode":mode(&e),"event":e})).is_ok());
    }
    assert!(
        normalize(
            "deepseek-harness",
            &json!({"hook_event_name":"Stop"}),
            None,
            TIME
        )
        .unwrap()
        .is_empty()
    );
}
#[test]
fn opencode_ignores_idle_and_uses_explicit_execution_and_permission_events() {
    for (phase, expected) in [
        ("session.execution.started", "task.started"),
        ("session.execution.succeeded", "task.completed"),
        ("session.execution.failed", "task.failed"),
        ("session.execution.interrupted", "task.cancelled"),
        ("permission.asked", "task.waiting_human"),
        ("permission.replied", "human.responded"),
    ] {
        let input = json!({"hook_event_name":phase,"session_id":"session-fixture","event_id":"event-1","occurred_at":TIME});
        let e = normalize("opencode", &input, None, TIME).unwrap().remove(0);
        assert_eq!(e.event_type, expected);
        assert_eq!(
            e.event_id,
            normalize("opencode", &input, None, "2026-11-18T00:00:00Z").unwrap()[0].event_id
        );
        assert!(parse(&json!({"mode":mode(&e),"event":e})).is_ok());
    }
    assert!(
        normalize(
            "opencode",
            &json!({"hook_event_name":"session.idle"}),
            None,
            TIME
        )
        .unwrap()
        .is_empty()
    );
}
#[test]
fn cli_hooks_filter_notifications_retries_and_non_user_continuations() {
    for (tool, phase, extra, expected) in [
        (
            "gemini-cli",
            "BeforeAgent",
            json!({"prompt":"写测试"}),
            "task.started",
        ),
        ("gemini-cli", "AfterAgent", json!({}), "task.completed"),
        (
            "gemini-cli",
            "Notification",
            json!({"notification_type":"ToolPermission"}),
            "task.waiting_human",
        ),
        (
            "qwen-code",
            "UserPromptSubmit",
            json!({"submitted_prompt":"写测试"}),
            "task.started",
        ),
        ("qwen-code", "StopFailure", json!({}), "task.failed"),
        (
            "qwen-code",
            "Notification",
            json!({"notification_type":"permission_prompt"}),
            "task.waiting_human",
        ),
    ] {
        let mut input = json!({"hook_event_name":phase,"session_id":"fixture"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let e = normalize(tool, &input, None, TIME).unwrap().remove(0);
        assert_eq!(e.event_type, expected);
        assert!(parse(&json!({"mode":mode(&e),"event":e})).is_ok());
    }
    assert!(
        normalize(
            "qwen-code",
            &json!({"hook_event_name":"UserPromptSubmit","prompt":"tool output"}),
            None,
            TIME
        )
        .unwrap()
        .is_empty()
    );
    assert!(
        normalize(
            "gemini-cli",
            &json!({"hook_event_name":"Notification","notification_type":"idle"}),
            None,
            TIME
        )
        .unwrap()
        .is_empty()
    );
    assert!(
        normalize(
            "gemini-cli",
            &json!({"hook_event_name":"AfterAgent","stop_hook_active":true}),
            None,
            TIME
        )
        .unwrap()
        .is_empty()
    );
}
