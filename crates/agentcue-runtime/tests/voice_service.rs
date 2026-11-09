use agentcue_runtime::{
    state::Runtime,
    voice::{
        Cancellation, SpeakResult,
        service::{Speaker, Voice},
    },
};
use agentcue_store::{engine::Event, migrate};
use futures_util::future::BoxFuture;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<(String, Value)>>,
    started: Notify,
    active: AtomicUsize,
    max_active: AtomicUsize,
    hang: bool,
}
impl Speaker for Fake {
    fn speak(
        &self,
        config: Value,
        text: String,
        mut cancel: Cancellation,
    ) -> BoxFuture<'_, SpeakResult> {
        Box::pin(async move {
            let count = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(count, Ordering::SeqCst);
            self.calls.lock().unwrap().push((text, config));
            self.started.notify_one();
            if self.hang {
                cancel.wait().await;
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            if cancel.cancelled() {
                SpeakResult::failed("播报已打断")
            } else {
                SpeakResult {
                    ok: true,
                    used_backend: Some("synthetic".into()),
                    errors: vec![],
                }
            }
        })
    }
    fn release(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn release_idle(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}
struct Fixture {
    dir: PathBuf,
    runtime: Arc<Runtime>,
    voice: Arc<Voice>,
    fake: Arc<Fake>,
}
impl Fixture {
    fn new(hang: bool) -> Self {
        let dir = std::env::temp_dir().join(format!("agentcue-voice-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&mut db).unwrap();
        let (runtime, receiver) = Runtime::new(db, &dir, dir.join("AgentCue")).unwrap();
        runtime
            .update_settings(
                &json!({"voice":{"scope":"milestones","volume":0.3},"quiet":{"ranges":[]}}),
            )
            .unwrap();
        let fake = Arc::new(Fake {
            hang,
            ..Default::default()
        });
        let voice = Voice::start(&runtime, receiver, fake.clone()).unwrap();
        Self {
            dir,
            runtime,
            voice,
            fake,
        }
    }
    async fn event(&self, id: &str, kind: &str) {
        let event:Event=serde_json::from_value(json!({"eventId":id,"sessionId":"codex:fixture:one","toolId":"codex","eventType":kind,"occurredAt":agentcue_runtime::queries::now(),"actor":"tool","schemaVersion":1,"payload":{"taskTitle":"检查 @repo/src/index.ts","taskSpeechTitle":"检查 index.ts"}})).unwrap();
        self.runtime.ingest(&[event], None, true).await.unwrap();
    }
    async fn calls(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while self.fake.calls.lock().unwrap().len() < count {
                self.fake.started.notified().await;
            }
        })
        .await
        .unwrap();
    }
    fn notifications(&self) -> i64 {
        self.runtime
            .db
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM notifications", [], |r| r.get(0))
            .unwrap()
    }
    async fn close(self) {
        self.voice.close().await;
        drop(self.voice);
        drop(self.runtime);
        fs::remove_dir_all(self.dir).unwrap();
    }
}
#[tokio::test]
async fn automatic_speech_contains_tool_task_and_volume_and_replayed_events_are_silent() {
    let f = Fixture::new(false);
    f.event("evt_start", "task.started").await;
    f.calls(1).await;
    f.event("evt_start", "task.started").await;
    f.event("evt_done", "task.completed").await;
    f.calls(2).await;
    {
        let calls = f.fake.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().all(|(s, config)| s.contains("CodeX CLI")
            && s.contains("index.ts")
            && !s.contains("@repo")
            && config["voice"]["volume"] == 0.3));
    }
    assert_eq!(f.fake.max_active.load(Ordering::SeqCst), 1);
    assert_eq!(f.notifications(), 0);
    f.close().await;
}
#[tokio::test]
async fn urgent_confirmation_interrupts_lower_priority_and_old_audio_does_not_resume() {
    let f = Fixture::new(true);
    f.event("evt_start", "task.started").await;
    f.calls(1).await;
    f.event("evt_wait", "task.waiting_human").await;
    f.calls(2).await;
    assert_eq!(f.fake.max_active.load(Ordering::SeqCst), 1);
    assert_eq!(f.notifications(), 1);
    assert_eq!(f.fake.calls.lock().unwrap().len(), 2);
    f.close().await;
}
#[tokio::test]
async fn global_mute_keeps_notifications_and_explicit_preview_uses_selected_settings() {
    let f = Fixture::new(false);
    f.runtime
        .update_settings(&json!({"quiet":{"globalMute":true,"waitingHumanOverride":true}}))
        .unwrap();
    let mut events = f.runtime.events.subscribe();
    f.event("evt_start", "task.started").await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while events.recv().await.unwrap()["type"] != "notify" {}
    })
    .await
    .unwrap();
    assert_eq!(f.notifications(), 1);
    assert!(f.fake.calls.lock().unwrap().is_empty());
    let result = f.voice.preview("重构 @repo/src/index.ts").await;
    assert!(result.ok);
    assert_eq!(result.used_backend.as_deref(), Some("synthetic"));
    assert_eq!(f.fake.calls.lock().unwrap()[0].0, "重构 index.ts");
    f.close().await;
}
#[tokio::test]
async fn reconfiguration_cancels_current_audio_and_turns_pending_items_into_single_notifications() {
    let f = Fixture::new(true);
    f.event("evt_start", "task.started").await;
    f.calls(1).await;
    f.runtime
        .update_settings(&json!({"voice":{"enabled":false}}))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while f.notifications() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.fake.calls.lock().unwrap().len(), 1);
    f.event("evt_done", "task.completed").await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while f.notifications() != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.fake.calls.lock().unwrap().len(), 1);
    f.close().await;
}
