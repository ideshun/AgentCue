use agentcue_runtime::{maintenance as data, state::Runtime};
use agentcue_store::open::open_database;
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
fn fixture() -> (PathBuf, Arc<Runtime>) {
    let root = std::env::temp_dir().join(format!("agentcue-maintenance-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let database = open_database(&root.join("awm.db")).unwrap();
    let (runtime, _) =
        Runtime::new(database.connection, &root, root.join("fixture-executable")).unwrap();
    runtime.db.lock().unwrap().execute_batch("INSERT INTO tools(tool_id,name,adapter_id,detect_status,first_seen_at,last_seen_at) VALUES('fixture','Fixture','fixture','installed','t','t');").unwrap();
    (root, runtime)
}
fn add(runtime: &Runtime, id: &str, state: &str) {
    runtime.db.lock().unwrap().execute("INSERT INTO sessions(session_id,tool_id,title,current_state,updated_at) VALUES(?1,'fixture','PRIVATE CONTENT',?2,'2020-01-01T00:00:00Z')",[id,state]).unwrap();
}
#[test]
fn wal_backup_and_deferred_restore_preserve_cloud_configuration() {
    let (root, runtime) = fixture();
    add(&runtime, "original", "completed");
    runtime.update_settings(&json!({"voice":{"cloudApiKey":"SYNTHETIC SECRET","cloudEndpoint":"https://example.com/v1/chat/completions"}})).unwrap();
    let backup = data::backup(&runtime).unwrap();
    let id = backup["id"].as_str().unwrap();
    let path = root.join("backups").join(id);
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["voice"]["cloudApiKey"], "");
    let snapshot = rusqlite::Connection::open(path.join("awm.db")).unwrap();
    assert_eq!(
        snapshot
            .query_row(
                "SELECT count(*) FROM sessions WHERE session_id='original'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    drop(snapshot);
    add(&runtime, "later", "running");
    let scheduled = data::request_restore(&runtime, id).unwrap();
    assert!(scheduled["safetyBackupId"].is_string());
    drop(runtime);
    data::apply_pending(&root, &root).unwrap();
    let db = open_database(&root.join("awm.db")).unwrap();
    assert_eq!(
        db.connection
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let restored = agentcue_runtime::settings::load(&root.join("settings.json")).unwrap();
    assert_eq!(restored["voice"]["cloudApiKey"], "SYNTHETIC SECRET");
    assert_eq!(
        restored["voice"]["cloudEndpoint"],
        "https://example.com/v1/chat/completions"
    );
    assert!(!root.join("restore-request.json").exists());
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn cleanup_preview_does_not_delete_and_unresolved_tasks_are_retained() {
    let (root, runtime) = fixture();
    for (id, state) in [
        ("done", "completed"),
        ("working", "running"),
        ("waiting", "waiting_human"),
        ("failed", "failed"),
        ("timeout", "timeout"),
    ] {
        add(&runtime, id, state);
    }
    let preview = data::cleanup(&runtime, 30, false).unwrap();
    assert_eq!(preview["count"], 1);
    assert_eq!(data::info(&runtime).unwrap()["sessions"], 5);
    assert_eq!(data::cleanup(&runtime, 30, true).unwrap()["count"], 1);
    assert_eq!(data::info(&runtime).unwrap()["sessions"], 4);
    assert!(data::cleanup(&runtime, 0, true).is_err());
    assert!(data::request_restore(&runtime, "../outside").is_err());
    let report = data::report(&runtime).unwrap().to_string();
    assert!(!report.contains("PRIVATE CONTENT"));
    assert!(!report.contains(&root.to_string_lossy().to_string()));
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn pronunciation_uses_longest_original_match_without_cascading() {
    let entries = json!({"Git":"git","GitHub":"git hub","重构":"chong gou","A":"B","B":"C"});
    assert_eq!(
        data::apply_pronunciation("GitHub Git GitLab 重构 A", &entries),
        "git hub git GitLab chong gou B"
    );
    let (root, runtime) = fixture();
    assert!(data::save_pronunciation(&root, &json!({"bad":"a\nb"})).is_err());
    assert!(data::set_preferences(&root, &json!({"retentionDays":1})).is_err());
    assert_eq!(
        data::save_pronunciation(&root, &entries).unwrap(),
        data::pronunciation(&root)
    );
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn symlinked_backups_are_rejected() {
    let (root, runtime) = fixture();
    let outside = std::env::temp_dir().join(format!("agentcue-outside-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("backups")).unwrap();
    assert!(data::backup(&runtime).is_err());
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

#[test]
fn corrupt_restore_is_reported_without_bricking_the_application() {
    let (root, runtime) = fixture();
    add(&runtime, "live", "running");
    let backup = data::backup(&runtime).unwrap();
    let id = backup["id"].as_str().unwrap();
    data::request_restore(&runtime, id).unwrap();
    std::fs::write(root.join("backups").join(id).join("awm.db"), b"damaged").unwrap();
    drop(runtime);
    data::apply_pending(&root, &root).unwrap();
    assert!(!root.join("restore-request.json").exists());
    let result: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("restore-result.json")).unwrap()).unwrap();
    assert_eq!(result["ok"], false);
    let db = open_database(&root.join("awm.db")).unwrap();
    assert_eq!(
        db.connection
            .query_row(
                "SELECT count(*) FROM sessions WHERE session_id='live'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn previous_schema_backup_remains_restorable_after_index_upgrade() {
    let (root, runtime) = fixture();
    add(&runtime, "preserved", "completed");
    let backup = data::backup(&runtime).unwrap();
    let id = backup["id"].as_str().unwrap();
    let old = rusqlite::Connection::open(root.join("backups").join(id).join("awm.db")).unwrap();
    old.execute_batch("DROP INDEX idx_sessions_board_state; DROP INDEX idx_events_tool_milestones; PRAGMA user_version=5;").unwrap();
    drop(old);
    data::request_restore(&runtime, id).unwrap();
    drop(runtime);
    data::apply_pending(&root, &root).unwrap();
    let upgraded = open_database(&root.join("awm.db")).unwrap();
    assert_eq!(
        upgraded
            .connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        agentcue_store::SCHEMA_VERSION
    );
    assert_eq!(
        upgraded
            .connection
            .query_row(
                "SELECT count(*) FROM sessions WHERE session_id='preserved'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    drop(upgraded);
    std::fs::remove_dir_all(root).unwrap();
}
