use agentcue_runtime::{discovery::Environment, monitor::Monitor, state::Runtime};
use agentcue_store::{engine::Event, migrate};
use chrono::Utc;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::mpsc;
struct Fixture {
    home: PathBuf,
    runtime: Arc<Runtime>,
    monitor: Arc<Monitor>,
    receiver: mpsc::Receiver<Event>,
}
impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("agentcue-monitor-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(home.join("data")).unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&mut db).unwrap();
        let (runtime, receiver) =
            Runtime::new(db, &home.join("data"), home.join("AgentCue")).unwrap();
        let monitor = Monitor::new(
            &runtime,
            Environment {
                platform: "macos".into(),
                home: home.clone(),
                vars: HashMap::new(),
                probe_system: false,
            },
        )
        .unwrap();
        Self {
            home,
            runtime,
            monitor,
            receiver,
        }
    }
    fn append(&self, path: &std::path::Path, value: Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .unwrap();
        writeln!(file, "{value}").unwrap();
    }
    fn event(kind: &str) -> Value {
        json!({"timestamp":(Utc::now()+chrono::Duration::seconds(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"type":"event_msg","payload":{"type":kind,"turn_id":"one"}})
    }
    fn close(self) {
        drop(self.monitor);
        drop(self.runtime);
        fs::remove_dir_all(self.home).unwrap();
    }
}
#[tokio::test]
async fn heartbeats_observe_without_consuming_new_file_content() {
    let mut f = Fixture::new();
    let source = f.home.join(".codex/sessions/project/fixture.jsonl");
    f.append(&source, Fixture::event("task_started"));
    assert_eq!(f.monitor.capture().await.unwrap(), 1);
    assert_eq!(f.receiver.try_recv().unwrap().event_type, "task.started");
    let source_path: String = {
        let db = f.runtime.db.lock().unwrap();
        db.query_row(
            "SELECT source_path FROM source_checkpoints WHERE tool_id='codex'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    let offset = {
        let db = f.runtime.db.lock().unwrap();
        agentcue_runtime::capture::checkpoint(&db, &source_path)
            .unwrap()
            .unwrap()
            .byte_offset
    };
    f.append(&source, Fixture::event("task_complete"));
    f.monitor.tick().await.unwrap();
    {
        let db = f.runtime.db.lock().unwrap();
        assert_eq!(
            agentcue_runtime::capture::checkpoint(&db, &source_path)
                .unwrap()
                .unwrap()
                .byte_offset,
            offset
        );
    }
    assert_eq!(f.monitor.capture().await.unwrap(), 1);
    assert_eq!(f.receiver.try_recv().unwrap().event_type, "task.completed");
    assert!(f.receiver.try_recv().is_err());
    f.close();
}
#[tokio::test]
async fn historical_indexes_do_not_become_active_tasks_and_ignoring_clears_them_immediately() {
    let f = Fixture::new();
    let index = f.home.join(".cline/data/sessions/sessions.index.json");
    fs::create_dir_all(index.parent().unwrap()).unwrap();
    fs::write(&index,json!({"version":1,"sessions":{"fixture":{"sessionId":"fixture","prompt":"合成历史任务","updatedAt":1780000000000_i64}}}).to_string()).unwrap();
    assert_eq!(f.monitor.capture().await.unwrap(), 0);
    assert_eq!(f.runtime.history.lock().unwrap().len(), 1);
    {
        let db = f.runtime.db.lock().unwrap();
        let count: i64 = db
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
    f.runtime
        .update_settings(&json!({"scan":{"ignoredToolIds":["cline"]}}))
        .unwrap();
    assert!(f.runtime.history.lock().unwrap().is_empty());
    f.monitor.capture().await.unwrap();
    assert!(f.runtime.history.lock().unwrap().is_empty());
    f.close();
}
#[tokio::test]
async fn privacy_stops_capture_and_waiting_timeout_is_recorded_only_once() {
    let mut f = Fixture::new();
    let source = f.home.join(".codex/sessions/project/fixture.jsonl");
    f.append(&source, Fixture::event("task_started"));
    f.runtime
        .update_settings(&json!({"privacy":{"sessionFileRead":false}}))
        .unwrap();
    assert_eq!(f.monitor.capture().await.unwrap(), 0);
    f.runtime
        .update_settings(&json!({"privacy":{"sessionFileRead":true}}))
        .unwrap();
    assert_eq!(f.monitor.capture().await.unwrap(), 1);
    let _ = f.receiver.try_recv();
    {
        let db = f.runtime.db.lock().unwrap();
        db.execute(
            "UPDATE sessions SET current_state='waiting_human',updated_at=?1",
            [(Utc::now() - chrono::Duration::minutes(31))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)],
        )
        .unwrap();
    }
    f.monitor.tick().await.unwrap();
    assert_eq!(f.receiver.try_recv().unwrap().event_type, "task.timeout");
    f.monitor.tick().await.unwrap();
    assert!(f.receiver.try_recv().is_err());
    f.close();
}
