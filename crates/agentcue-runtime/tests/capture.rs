use agentcue_runtime::{capture, queries, state::Runtime};
use agentcue_store::{engine::Event, migrate};
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::mpsc;
struct Fixture {
    dir: PathBuf,
    source: PathBuf,
    runtime: Arc<Runtime>,
    receiver: mpsc::Receiver<Event>,
    manifest: Value,
    baseline: DateTime<Utc>,
    stamp: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("agentcue-capture-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("project")).unwrap();
        let mut db = Connection::open(dir.join("awm.db")).unwrap();
        migrate(&mut db).unwrap();
        let (runtime, receiver) = Runtime::new(db, &dir, dir.join("AgentCue")).unwrap();
        let manifest = runtime
            .manifests
            .iter()
            .find(|m| m["id"] == "codex")
            .unwrap()
            .clone();
        let stamp = queries::now();
        Self {
            source: dir.join("project/session.jsonl"),
            dir,
            runtime,
            receiver,
            manifest,
            baseline: Utc::now() - chrono::Duration::seconds(1),
            stamp,
        }
    }
    fn event(&self, kind: &str, turn: &str) -> String {
        format!(
            "{}\n",
            json!({"type":"event_msg","timestamp":self.stamp,"payload":{"type":kind,"turn_id":turn}})
        )
    }
    fn append(&self, text: &str) {
        let mut f = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.source)
            .unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }
    async fn capture(&self) -> capture::CaptureResult {
        capture::file(
            self.runtime.clone(),
            &self.manifest,
            &self.source,
            self.baseline,
        )
        .await
        .unwrap()
    }
    fn offset(&self) -> i64 {
        let db = self.runtime.db.lock().unwrap();
        capture::checkpoint(&db, self.source.to_str().unwrap())
            .unwrap()
            .map(|p| p.byte_offset)
            .unwrap_or(0)
    }
    fn drain(&mut self) -> Vec<String> {
        let mut result = vec![];
        while let Ok(e) = self.receiver.try_recv() {
            result.push(e.event_type);
        }
        result
    }
    fn close(self) {
        drop(self.runtime);
        fs::remove_dir_all(self.dir).unwrap();
    }
}
#[tokio::test]
async fn append_partial_lines_and_replay_announce_each_milestone_once() {
    let mut f = Fixture::new();
    f.append(&f.event("task_started", "one"));
    f.append(&format!("{}\n",json!({"type":"event_msg","payload":{"type":"user_message","message":"改造 @repo/packages/components 的选择器"}})));
    assert_eq!(f.capture().await.ingested, 1);
    assert_eq!(f.drain(), vec!["task.started"]);
    let offset = f.offset();
    let completed = f.event("task_complete", "one");
    let split = completed.len() / 2;
    f.append(&completed[..split]);
    assert_eq!(f.capture().await.ingested, 0);
    assert_eq!(f.offset(), offset);
    assert!(f.drain().is_empty());
    f.append(&completed[split..]);
    assert_eq!(f.capture().await.ingested, 1);
    assert_eq!(f.drain(), vec!["task.completed"]);
    assert_eq!(f.capture().await.ingested, 0);
    assert!(f.drain().is_empty());
    {
        let db = f.runtime.db.lock().unwrap();
        let title: String = db
            .query_row("SELECT title FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert!(title.contains("@repo/"));
    }
    f.close();
}
#[tokio::test]
async fn truncation_and_replacement_can_reset_offsets_without_replaying_old_events() {
    let mut f = Fixture::new();
    let initial = f.event("task_started", "one") + &f.event("task_complete", "one");
    f.append(&initial);
    f.append(&format!(
        "{}\n",
        json!({"type":"padding","text":"x".repeat(16000)})
    ));
    f.capture().await;
    let old_offset = f.offset();
    assert_eq!(f.drain().len(), 2);
    fs::write(&f.source, &initial).unwrap();
    assert_eq!(f.capture().await.ingested, 0);
    assert!(f.offset() < old_offset);
    assert!(f.drain().is_empty());
    let replacement = f.dir.join("replacement");
    fs::write(
        &replacement,
        initial.clone() + &f.event("task_started", "two"),
    )
    .unwrap();
    fs::rename(replacement, &f.source).unwrap();
    assert_eq!(f.capture().await.ingested, 1);
    assert_eq!(f.drain(), vec!["task.started"]);
    f.close();
}
#[tokio::test]
async fn persisted_checkpoint_survives_a_new_runtime_and_privacy_or_ignore_blocks_reads() {
    let mut f = Fixture::new();
    f.append(&f.event("task_started", "one"));
    f.capture().await;
    assert_eq!(f.drain().len(), 1);
    let offset = f.offset();
    let Fixture {
        dir,
        source,
        runtime,
        receiver,
        manifest,
        baseline,
        stamp,
    } = f;
    drop(runtime);
    drop(receiver);
    let db = Connection::open(dir.join("awm.db")).unwrap();
    let (runtime, receiver) = Runtime::new(db, &dir, dir.join("AgentCue")).unwrap();
    f = Fixture {
        dir,
        source,
        runtime,
        receiver,
        manifest,
        baseline,
        stamp,
    };
    assert_eq!(f.capture().await.ingested, 0);
    assert_eq!(f.offset(), offset);
    assert!(f.drain().is_empty());
    f.runtime
        .update_settings(&json!({"privacy":{"sessionFileRead":false}}))
        .unwrap();
    f.append(&f.event("task_complete", "one"));
    assert_eq!(f.capture().await.ingested, 0);
    assert_eq!(f.offset(), offset);
    f.runtime
        .update_settings(
            &json!({"privacy":{"sessionFileRead":true},"scan":{"ignoredToolIds":["codex"]}}),
        )
        .unwrap();
    assert_eq!(f.capture().await.ingested, 0);
    assert_eq!(f.offset(), offset);
    f.runtime
        .update_settings(&json!({"scan":{"ignoredToolIds":[]}}))
        .unwrap();
    assert_eq!(f.capture().await.ingested, 1);
    assert_eq!(f.drain(), vec!["task.completed"]);
    f.close();
}
#[tokio::test]
async fn large_record_does_not_starve_later_events_and_bad_complete_lines_are_counted() {
    let mut f = Fixture::new();
    f.append(&f.event("task_started", "one"));
    f.append("invalid JSON\n");
    f.append(&format!(
        "{}\n",
        json!({"type":"response_item","payload":{"type":"image","data":"x".repeat(10*1024*1024)}})
    ));
    f.append(&f.event("task_complete", "one"));
    let first = f.capture().await;
    assert_eq!(first.ingested, 1);
    assert_eq!(first.bad_lines, 1);
    let second = f.capture().await;
    assert_eq!(second.ingested, 1);
    assert_eq!(f.offset(), fs::metadata(&f.source).unwrap().len() as i64);
    assert_eq!(f.drain(), vec!["task.started", "task.completed"]);
    f.close();
}
#[tokio::test]
async fn internal_sources_and_detection_only_adapters_never_create_active_tasks() {
    let mut f = Fixture::new();
    f.append(&format!("{}\n",json!({"type":"session_meta","payload":{"source":{"subagent":{"thread_spawn":{"depth":1}}}}})));
    f.append(&f.event("task_started", "one"));
    assert_eq!(f.capture().await.ingested, 0);
    assert!(f.drain().is_empty());
    {
        let db = f.runtime.db.lock().unwrap();
        let n: i64 = db
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
    f.manifest["sessionCapability"] = json!("detect-only");
    fs::write(&f.source, f.event("task_started", "two")).unwrap();
    assert_eq!(f.capture().await.ingested, 0);
    f.close();
}
