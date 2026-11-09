//! Serial playback actor. IPC requests never own a detached or overlapping audio process.
use super::{
    Cancellation, SpeakResult,
    backends::Backends,
    policy::{self, Dedupe, Signal},
};
use crate::{control, queries, state::Runtime};
use agentcue_store::engine::Event;
use chrono::Timelike;
use futures_util::future::BoxFuture;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
/// A playback boundary permits lifecycle tests without relying on an installed audio device.
pub trait Speaker: Send + Sync {
    fn speak(
        &self,
        config: Value,
        text: String,
        cancel: Cancellation,
    ) -> BoxFuture<'_, SpeakResult>;
    fn release(&self) -> BoxFuture<'_, ()>;
    fn release_idle(&self) -> BoxFuture<'_, ()>;
}
impl Speaker for Backends {
    fn speak(
        &self,
        config: Value,
        text: String,
        cancel: Cancellation,
    ) -> BoxFuture<'_, SpeakResult> {
        Box::pin(async move { Backends::speak(self, &config, text, cancel).await })
    }
    fn release(&self) -> BoxFuture<'_, ()> {
        Box::pin(Backends::release(self))
    }
    fn release_idle(&self) -> BoxFuture<'_, ()> {
        Box::pin(Backends::release_idle(self))
    }
}
enum Command {
    Preview {
        text: String,
        generation: u64,
        reply: oneshot::Sender<SpeakResult>,
    },
    Reconfigure,
    Stop,
}
pub struct Voice {
    commands: mpsc::UnboundedSender<Command>,
    generation: Arc<AtomicU64>,
    task: Mutex<Option<JoinHandle<()>>>,
}
impl Voice {
    pub fn start(
        runtime: &Arc<Runtime>,
        notices: mpsc::Receiver<Event>,
        speaker: Arc<dyn Speaker>,
    ) -> Result<Arc<Self>, String> {
        let (commands, receiver) = mpsc::unbounded_channel();
        let generation = Arc::new(AtomicU64::new(0));
        let actor = Actor {
            runtime: runtime.clone(),
            speaker,
            commands: receiver,
            notices,
            generation: generation.clone(),
            queue: vec![],
            playing: None,
            spoken: Dedupe::default(),
            notified: Dedupe::default(),
            sequence: 0,
        };
        let task = tokio::spawn(actor.run());
        let service = Arc::new(Self {
            commands,
            generation,
            task: Mutex::new(Some(task)),
        });
        runtime
            .voice
            .set(Arc::downgrade(&service))
            .map_err(|_| "播报服务已经启动")?;
        Ok(service)
    }
    pub async fn preview(&self, text: &str) -> SpeakResult {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let (reply, receiver) = oneshot::channel();
        let text = policy::truncate(&policy::normalize(text), 200);
        if self
            .commands
            .send(Command::Preview {
                text,
                generation,
                reply,
            })
            .is_err()
        {
            return SpeakResult::failed("播报服务已停止");
        }
        receiver
            .await
            .unwrap_or_else(|_| SpeakResult::failed("播报服务已经退出"))
    }
    pub fn reconfigure(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let _ = self.commands.send(Command::Reconfigure);
    }
    pub async fn close(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let _ = self.commands.send(Command::Stop);
        let task = self.task.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}
impl Drop for Voice {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
    }
}
#[derive(Clone)]
struct Queued {
    signal: Signal,
    priority: u8,
    after: Instant,
    sequence: u64,
}
enum Kind {
    Auto(Signal),
    Preview(oneshot::Sender<SpeakResult>),
}
struct Playing {
    task: JoinHandle<SpeakResult>,
    cancel: watch::Sender<u64>,
    kind: Kind,
    priority: u8,
}
struct Actor {
    runtime: Arc<Runtime>,
    speaker: Arc<dyn Speaker>,
    commands: mpsc::UnboundedReceiver<Command>,
    notices: mpsc::Receiver<Event>,
    generation: Arc<AtomicU64>,
    queue: Vec<Queued>,
    playing: Option<Playing>,
    spoken: Dedupe,
    notified: Dedupe,
    sequence: u64,
}
enum Wake {
    Command(Option<Command>),
    Notice(Option<Event>),
    Complete(std::result::Result<SpeakResult, tokio::task::JoinError>),
    Ready,
    Idle,
}
impl Actor {
    async fn run(mut self) {
        let mut idle = tokio::time::interval(Duration::from_secs(30));
        idle.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            self.schedule().await;
            let deadline = self.queue.first().and_then(|q| {
                if self
                    .playing
                    .as_ref()
                    .is_none_or(|p| matches!(p.kind, Kind::Auto(_)) && q.priority > p.priority)
                {
                    Some(q.after)
                } else {
                    None
                }
            });
            let wake = {
                let completion = async {
                    if let Some(p) = &mut self.playing {
                        (&mut p.task).await
                    } else {
                        futures_util::future::pending().await
                    }
                };
                let ready = async {
                    if let Some(deadline) = deadline {
                        tokio::time::sleep_until(deadline.into()).await;
                    } else {
                        futures_util::future::pending().await
                    }
                };
                tokio::select! {biased;
                    command=self.commands.recv()=>Wake::Command(command),
                    event=self.notices.recv()=>Wake::Notice(event),
                    result=completion=>Wake::Complete(result),
                    _=ready=>Wake::Ready,
                    _=idle.tick()=>Wake::Idle,
                }
            };
            match wake {
                Wake::Command(Some(Command::Preview {
                    text,
                    generation,
                    reply,
                })) => {
                    self.interrupt("preview-interrupted", true).await;
                    self.clear_queue("preview-interrupted");
                    if generation != self.generation.load(Ordering::Acquire) {
                        let _ = reply.send(SpeakResult::failed("播报已打断"));
                        continue;
                    }
                    let config = self.runtime.config();
                    self.play(config, text, Kind::Preview(reply), u8::MAX);
                }
                Wake::Command(Some(Command::Reconfigure)) => {
                    self.interrupt("settings-changed", true).await;
                    self.clear_queue("settings-changed");
                    self.speaker.release().await;
                }
                Wake::Command(Some(Command::Stop)) | Wake::Command(None) | Wake::Notice(None) => {
                    break;
                }
                Wake::Notice(Some(event)) => {
                    self.accept(event);
                }
                Wake::Complete(result) => {
                    if let Some(playing) = self.playing.take() {
                        let result =
                            result.unwrap_or_else(|_| SpeakResult::failed("播报任务异常退出"));
                        match playing.kind {
                            Kind::Preview(reply) => {
                                let _ = reply.send(result);
                            }
                            Kind::Auto(signal) if !result.ok => self.notify(&signal, "tts-failed"),
                            _ => {}
                        }
                    }
                }
                Wake::Ready => {}
                Wake::Idle => self.speaker.release_idle().await,
            }
        }
        self.queue.clear();
        self.interrupt("service-stopped", false).await;
        self.speaker.release().await;
    }
    fn signal(&self, event: &Event) -> Option<Signal> {
        let db = self.runtime.db.lock().ok()?;
        let session: Option<(Option<String>, i64)> = db
            .query_row(
                "SELECT title,visible FROM sessions WHERE session_id=?",
                [&event.session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()?;
        if session.as_ref().is_some_and(|s| s.1 == 0) {
            return None;
        }
        let started:Option<String>=db.query_row("SELECT payload FROM state_events WHERE session_id=?1 AND event_type='task.started' AND rowid<=coalesce((SELECT rowid FROM state_events WHERE event_id=?2),9223372036854775807) ORDER BY rowid DESC LIMIT 1",params![event.session_id,event.event_id],|r|r.get(0)).optional().ok().flatten();
        let started = started.and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let event_title = event
            .payload
            .get("taskTitle")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty());
        let title = event_title
            .or_else(|| {
                started
                    .as_ref()
                    .and_then(|v| v["taskTitle"].as_str())
                    .filter(|s| !s.trim().is_empty())
            })
            .map(str::to_owned)
            .or_else(|| session.and_then(|s| s.0));
        let spoken = event
            .payload
            .get("taskSpeechTitle")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                started.as_ref().and_then(|v| {
                    let matching = v["taskTitle"]
                        .as_str()
                        .zip(title.as_deref())
                        .is_some_and(|(a, b)| a.trim() == b.trim());
                    matching
                        .then(|| v["taskSpeechTitle"].as_str().map(str::to_owned))
                        .flatten()
                })
            });
        let name: String = db
            .query_row(
                "SELECT name FROM tools WHERE tool_id=?",
                [&event.tool_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or_else(|| event.tool_id.clone());
        Some(Signal {
            event_id: event.event_id.clone(),
            tool_id: event.tool_id.clone(),
            tool_name: name,
            event_type: event.event_type.clone(),
            session_id: event.session_id.clone(),
            title,
            speech_title: spoken,
        })
    }
    fn rules(&self) -> Vec<Value> {
        self.runtime
            .db
            .lock()
            .ok()
            .and_then(|db| control::voice_rules(&db).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
    }
    fn accept(&mut self, event: Event) {
        let Some(signal) = self.signal(&event) else {
            return;
        };
        if !self.runtime.enabled(&signal.tool_id) {
            return;
        }
        let rules = self.rules();
        let rule = policy::match_rule(&rules, &signal);
        if rule.is_some_and(|r| r["action"] == "mute") {
            return;
        }
        let config = self.runtime.config();
        let in_scope = policy::in_scope(
            config["voice"]["scope"].as_str().unwrap_or("attention"),
            &signal.event_type,
        );
        let dedupe = if in_scope {
            &mut self.spoken
        } else {
            &mut self.notified
        };
        let Some(delay) = dedupe.accept(&signal, Instant::now()) else {
            return;
        };
        if !self.may_speak(&signal, &config, rule) {
            self.notify(&signal, "notification-only");
            return;
        }
        let priority = rule
            .and_then(|r| r["priority"].as_str())
            .map(|p| match p {
                "high" => 3,
                "mid" => 2,
                _ => 1,
            })
            .unwrap_or_else(|| policy::priority(&signal.event_type));
        self.sequence = self.sequence.wrapping_add(1);
        self.queue.push(Queued {
            signal,
            priority,
            after: Instant::now() + delay,
            sequence: self.sequence,
        });
        self.queue
            .sort_by_key(|q| (std::cmp::Reverse(q.priority), q.sequence));
    }
    fn may_speak(&self, signal: &Signal, config: &Value, rule: Option<&Value>) -> bool {
        let now = chrono::Local::now();
        config["voice"]["enabled"] == true
            && policy::automatic(&signal.event_type)
            && policy::in_scope(
                config["voice"]["scope"].as_str().unwrap_or("attention"),
                &signal.event_type,
            )
            && !policy::quiet(config, &signal.event_type, now.hour() * 60 + now.minute())
            && rule.is_none_or(|r| r["action"] == "speak")
    }
    fn notify(&self, signal: &Signal, reason: &str) {
        if !self.runtime.enabled(&signal.tool_id) {
            return;
        }
        let rules = self.rules();
        if policy::match_rule(&rules, signal).is_some_and(|r| r["action"] == "mute") {
            return;
        }
        let title = format!(
            "{} · {}",
            policy::tool_name(signal),
            policy::label(&signal.event_type)
        );
        let body = policy::task_title(signal, 40);
        let attention = policy::attention(&signal.event_type);
        let saved=self.runtime.db.lock().ok().and_then(|db|db.execute("INSERT OR IGNORE INTO notifications(notification_id,ts,title,body,level,read,session_id) VALUES(?1,?2,?3,?4,?5,0,?6)",params![format!("notify_{}",signal.event_id),queries::now(),title,body,if attention{"attention"}else{"info"},signal.session_id]).ok()).is_some_and(|n|n>0);
        if saved {
            self.runtime.emit("notify",json!({"title":title,"body":body,"attention":attention,"reason":reason,"sessionId":signal.session_id}));
        }
    }
    fn clear_queue(&mut self, reason: &str) {
        for item in std::mem::take(&mut self.queue) {
            self.notify(&item.signal, reason);
        }
    }
    fn play(&mut self, config: Value, text: String, kind: Kind, priority: u8) {
        let (cancel, receiver) = watch::channel(0);
        let speaker = self.speaker.clone();
        let task = tokio::spawn(async move {
            speaker
                .speak(
                    config,
                    text,
                    Cancellation {
                        receiver,
                        generation: 0,
                    },
                )
                .await
        });
        self.playing = Some(Playing {
            task,
            cancel,
            kind,
            priority,
        });
    }
    async fn interrupt(&mut self, reason: &str, notify: bool) {
        if let Some(mut playing) = self.playing.take() {
            let finished = playing.task.is_finished();
            let _ = playing.cancel.send(1);
            let result = match tokio::time::timeout(Duration::from_secs(3), &mut playing.task).await
            {
                Ok(Ok(result)) => result,
                _ => {
                    playing.task.abort();
                    let _ = playing.task.await;
                    SpeakResult::failed("播报已打断")
                }
            };
            match playing.kind {
                Kind::Preview(reply) => {
                    let _ = reply.send(if finished {
                        result
                    } else {
                        SpeakResult::failed("播报已打断")
                    });
                }
                Kind::Auto(signal) if notify && (!finished || !result.ok) => {
                    self.notify(&signal, reason)
                }
                _ => {}
            }
        }
    }
    async fn schedule(&mut self) {
        loop {
            let Some(next) = self.queue.first() else {
                return;
            };
            if next.after > Instant::now() {
                return;
            }
            if let Some(playing) = &self.playing {
                if matches!(playing.kind, Kind::Preview(_)) || playing.priority >= next.priority {
                    return;
                }
                self.interrupt("higher-priority", true).await;
            }
            let item = self.queue.remove(0);
            let config = self.runtime.config();
            let rules = self.rules();
            let rule = policy::match_rule(&rules, &item.signal);
            if rule.is_some_and(|r| r["action"] == "mute")
                || !self.runtime.enabled(&item.signal.tool_id)
            {
                continue;
            }
            if !self.may_speak(&item.signal, &config, rule) {
                self.notify(&item.signal, "settings-changed");
                continue;
            }
            let text = policy::announcement(&item.signal, &config, rule);
            self.play(config, text, Kind::Auto(item.signal), item.priority);
            return;
        }
    }
}
