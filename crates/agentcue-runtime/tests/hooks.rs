use agentcue_adapters::hooks;
use agentcue_runtime::{hooks as consumer, state::Runtime};
use agentcue_store::{engine::Event, migrate};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, sync::Arc};
use tokio::sync::mpsc;
struct Fixture {
    dir: PathBuf,
    runtime: Arc<Runtime>,
    receiver: mpsc::Receiver<Event>,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("agentcue-hooks-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&mut db).unwrap();
        let (runtime, receiver) = Runtime::new(db, &dir, dir.join("AgentCue")).unwrap();
        Self {
            dir,
            runtime,
            receiver,
        }
    }
    async fn send(&self, tool: &str, payload: Value, time: &str) -> Value {
        let event = hooks::normalize(tool, &payload, None, time)
            .unwrap()
            .remove(0);
        let mode = hooks::mode(&event);
        let envelope = hooks::parse(&json!({"mode":mode,"event":event})).unwrap();
        consumer::consume(&self.runtime, envelope).await.unwrap()
    }
    fn drain(&mut self) -> Vec<String> {
        let mut events = vec![];
        while let Ok(e) = self.receiver.try_recv() {
            events.push(e.event_type);
        }
        events
    }
    fn close(self) {
        drop(self.runtime);
        fs::remove_dir_all(self.dir).unwrap();
    }
}
const T0: &str = "2026-11-08T00:00:00.000Z";
const T1: &str = "2026-11-08T00:00:01.000Z";
const T2: &str = "2026-11-08T00:00:02.000Z";
fn cursor(phase: &str) -> Value {
    json!({"hook_event_name":phase,"conversation_id":"fixture","generation_id":"one","prompt":"检查 @repo/src/index.ts","tool_name":"AskQuestion","status":"completed"})
}
#[tokio::test]
async fn cursor_announces_only_each_real_milestone_once_and_silently_resumes_terminal() {
    let mut f = Fixture::new();
    assert_eq!(
        f.send("cursor", cursor("beforeSubmitPrompt"), T0).await["accepted"],
        true
    );
    f.send("cursor", cursor("preToolUse"), T1).await;
    f.send("cursor", cursor("stop"), T2).await;
    assert_eq!(
        f.drain(),
        vec!["task.started", "task.waiting_human", "task.completed"]
    );
    for phase in ["beforeSubmitPrompt", "preToolUse", "stop"] {
        assert_eq!(f.send("cursor", cursor(phase), T2).await["accepted"], false);
    }
    assert!(f.drain().is_empty());
    {
        let db = f.runtime.db.lock().unwrap();
        let state: String = db
            .query_row("SELECT current_state FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state, "completed");
        let resumed:i64=db.query_row("SELECT count(*) FROM state_events WHERE event_type='human.responded' AND actor='system'",[],|r|r.get(0)).unwrap();
        assert_eq!(resumed, 1);
    }
    f.close();
}
#[tokio::test]
async fn cline_completion_before_start_recovers_the_same_task_without_late_start_announcement() {
    let mut f = Fixture::new();
    let complete =
        json!({"hookName":"TaskComplete","taskId":"fixture","timestamp":"1794096002000"});
    let ended = f.send("cline", complete.clone(), T2).await;
    assert_eq!(ended["accepted"], true);
    assert_eq!(f.drain(), vec!["task.completed"]);
    let start = json!({"hookName":"TaskStart","taskId":"fixture","timestamp":"1794096000000","taskStart":{"taskMetadata":{"initialTask":"真实用户请求"}}});
    let late = f.send("cline", start, T2).await;
    assert_eq!(late["sessionId"], ended["sessionId"]);
    assert_eq!(late["accepted"], false);
    assert!(f.drain().is_empty());
    {
        let db = f.runtime.db.lock().unwrap();
        let row: (String, String) = db
            .query_row("SELECT current_state,title FROM sessions", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(row, ("completed".into(), "真实用户请求".into()));
    }
    assert_eq!(f.send("cline", complete, T2).await["accepted"], false);
    f.close();
}
#[tokio::test]
async fn legacy_sessions_split_new_turns_and_reusable_identity_archives_before_restart() {
    let mut f = Fixture::new();
    let start =
        json!({"hook_event_name":"UserPromptSubmit","session_id":"fixture","prompt":"第一轮"});
    let first = f.send("codebuddy", start.clone(), T0).await;
    let second = f.send("codebuddy", start, T1).await;
    assert_ne!(first["sessionId"], second["sessionId"]);
    let done = f
        .send(
            "codebuddy",
            json!({"hook_event_name":"Stop","session_id":"fixture"}),
            T2,
        )
        .await;
    assert_eq!(done["sessionId"], second["sessionId"]);
    assert_eq!(
        f.drain(),
        vec!["task.started", "task.started", "task.completed"]
    );
    let start = json!({"hook_event_name":"UserPromptSubmit","session_id":"main","transcript_path":"/synthetic/project/session.jsonl","prompt_id":"one","prompt":"第一轮"});
    let first = f.send("claude-code", start, T0).await;
    f.send("claude-code",json!({"hook_event_name":"Stop","session_id":"main","transcript_path":"/synthetic/project/session.jsonl","prompt_id":"one"}),T1).await;
    let second=f.send("claude-code",json!({"hook_event_name":"UserPromptSubmit","session_id":"main","transcript_path":"/synthetic/project/session.jsonl","prompt_id":"two","prompt":"第二轮"}),T2).await;
    assert_eq!(first["sessionId"], second["sessionId"]);
    assert_eq!(second["accepted"], true);
    assert_eq!(
        f.drain(),
        vec!["task.started", "task.completed", "task.started"]
    );
    f.close();
}
#[tokio::test]
async fn privacy_and_failed_transactions_leave_no_receipts_or_synthetic_side_effects() {
    let mut f = Fixture::new();
    f.runtime
        .update_settings(&json!({"privacy":{"sessionFileRead":false}}))
        .unwrap();
    assert_eq!(
        f.send("cursor", cursor("stop"), T2).await["reason"],
        "disabled"
    );
    assert!(f.drain().is_empty());
    f.runtime
        .update_settings(&json!({"privacy":{"sessionFileRead":true}}))
        .unwrap();
    {
        let db = f.runtime.db.lock().unwrap();
        db.execute_batch("CREATE TRIGGER reject_terminal BEFORE INSERT ON state_events WHEN NEW.event_type='task.completed' BEGIN SELECT RAISE(ABORT,'fixture');END;").unwrap();
    }
    let event = hooks::normalize("cursor", &cursor("stop"), None, T2)
        .unwrap()
        .remove(0);
    let envelope = hooks::parse(&json!({"mode":"turn","event":event})).unwrap();
    assert!(consumer::consume(&f.runtime, envelope).await.is_err());
    {
        let db = f.runtime.db.lock().unwrap();
        for table in ["sessions", "state_events", "source_receipts"] {
            let n: i64 = db
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0);
        }
    }
    assert!(f.drain().is_empty());
    f.close();
}
