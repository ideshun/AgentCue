use agentcue_runtime::{
    settings,
    voice::policy::{self, Dedupe, Signal},
};
use serde_json::json;
use std::time::{Duration, Instant};
fn signal() -> Signal {
    Signal {
        event_id: "evt_fixture".into(),
        tool_id: "fixture".into(),
        tool_name: "合成工具".into(),
        event_type: "task.completed".into(),
        session_id: "fixture:session".into(),
        title: Some("改造 @repo/packages/components 的选择器".into()),
        speech_title: Some("改造 components 的选择器".into()),
    }
}
#[test]
fn custom_templates_keep_tool_and_task_identity_and_do_not_speak_paths() {
    let s = signal();
    let text = policy::announcement(
        &s,
        &json!({"voice":{"content":"title"}}),
        Some(&json!({"template":"{title} 完成"})),
    );
    assert!(text.contains("合成工具"));
    assert!(text.contains("components"));
    assert!(!text.contains("@repo"));
    assert!(!text.contains("packages/"));
    let text = policy::announcement(
        &s,
        &json!({"voice":{"content":"prompt"}}),
        Some(&json!({"template":"处理好了"})),
    );
    assert!(text.contains("合成工具"));
    assert!(text.contains("选择器"));
    assert!(text.chars().count() <= 200);
}
#[test]
fn speech_uses_a_plain_label_for_untitled_tasks() {
    let mut s = signal();
    s.title = None;
    s.speech_title = None;
    for content in ["title", "prompt"] {
        let text = policy::announcement(&s, &json!({"voice":{"content":content}}), None);
        assert_eq!(text, "合成工具 的任务已经完成，未命名任务。");
    }
    assert_eq!(policy::task_title(&s, 40), "未命名任务");
}
#[test]
fn mute_precedes_waiting_override_and_only_three_milestones_can_speak() {
    let defaults = settings::defaults();
    let scope = defaults["voice"]["scope"].as_str().unwrap();
    let mut config = json!({"quiet":{"globalMute":true,"waitingHumanOverride":true,"ranges":[{"from":"22:30","to":"08:30"}]}});
    assert!(policy::quiet(&config, "task.waiting_human", 23 * 60));
    config["quiet"]["globalMute"] = json!(false);
    assert!(!policy::quiet(&config, "task.waiting_human", 23 * 60));
    assert!(policy::quiet(&config, "task.completed", 23 * 60));
    assert!(!policy::quiet(&config, "task.completed", 12 * 60));
    for kind in ["task.started", "task.waiting_human", "task.completed"] {
        assert!(policy::automatic(kind));
        assert!(policy::in_scope(scope, kind));
    }
    for kind in [
        "task.failed",
        "human.responded",
        "task.retried",
        "heartbeat.lost",
    ] {
        assert!(!policy::automatic(kind));
    }
}
#[test]
fn stable_ids_and_recent_session_events_are_deduplicated_without_dropping_fresh_cooldown_events() {
    let mut dedupe = Dedupe::default();
    let now = Instant::now();
    let first = signal();
    assert_eq!(dedupe.accept(&first, now), Some(Duration::ZERO));
    assert_eq!(dedupe.accept(&first, now + Duration::from_secs(60)), None);
    let mut second = first.clone();
    second.event_id = "evt_second".into();
    second.session_id = "different".into();
    assert_eq!(
        dedupe.accept(&second, now + Duration::from_millis(100)),
        Some(Duration::from_millis(1900))
    );
    assert_eq!(dedupe.accept(&second, now + Duration::from_secs(4)), None);
}
#[test]
fn speech_normalization_is_idempotent_and_keeps_normal_urls_and_email() {
    let input = "v1.2.3 将在 12:30 处理 1.5GB，已完成 45%，耗时 300ms。";
    let actual = policy::normalize(input);
    assert_eq!(
        actual,
        "版本 1.2.3 将在 12 点 30 分 处理 1.5 吉字节，已完成 百分之 45，耗时 300 毫秒。"
    );
    assert_eq!(policy::normalize(&actual), actual);
    assert_eq!(
        policy::normalize("name@example.com api/v1 @person"),
        "name@example.com api/v1 @person"
    );
}
