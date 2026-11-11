use crate::{queries, settings};
use agentcue_store::engine::{Checkpoint, Event, Transition, ingest_batch};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::{broadcast, mpsc};

pub struct Runtime {
    pub db: Mutex<Connection>,
    pub settings: Mutex<Value>,
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub executable: PathBuf,
    pub manifests: Vec<Value>,
    pub history: Mutex<Vec<Value>>,
    pub last_scan: Mutex<Option<Value>>,
    pub events: broadcast::Sender<Value>,
    pub notices: mpsc::Sender<Event>,
    pub started: Instant,
    pub generation: AtomicU64,
    pub monitor: OnceLock<Weak<crate::monitor::Monitor>>,
    pub models: OnceLock<Weak<crate::voice::models::Models>>,
    pub voice: OnceLock<Weak<crate::voice::service::Voice>>,
}

pub fn manifests() -> Vec<Value> {
    serde_json::from_str(include_str!("../resources/adapters.json")).expect("embedded adapters")
}
fn db_error() -> io::Error {
    io::Error::other("本机数据库暂不可用")
}
impl Runtime {
    /// The desktop host owns the single-instance guard before supplying this connection.
    pub fn new(
        db: Connection,
        data_dir: &Path,
        executable: PathBuf,
    ) -> Result<(Arc<Self>, mpsc::Receiver<Event>), Box<dyn std::error::Error + Send + Sync>> {
        Self::new_with_config_dir(db, data_dir, data_dir, executable)
    }

    pub fn new_with_config_dir(
        db: Connection,
        data_dir: &Path,
        config_dir: &Path,
        executable: PathBuf,
    ) -> Result<(Arc<Self>, mpsc::Receiver<Event>), Box<dyn std::error::Error + Send + Sync>> {
        fs::create_dir_all(data_dir)?;
        fs::create_dir_all(config_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))?;
            if config_dir != data_dir {
                fs::set_permissions(config_dir, fs::Permissions::from_mode(0o700))?;
            }
        }
        let settings_path = config_dir.join("settings.json");
        let mut config = settings::load(&settings_path)?;
        let definitions = manifests();
        let stamp = queries::now();
        for manifest in &definitions {
            db.execute("INSERT INTO tools(tool_id,name,adapter_id,detect_status,first_seen_at,last_seen_at) VALUES(?1,?2,?1,'unknown',?3,?3) ON CONFLICT(tool_id) DO UPDATE SET name=excluded.name",params![manifest["id"].as_str(),manifest["name"].as_str(),stamp])?;
        }
        seed_rules(&db, &mut config)?;
        settings::write_atomic(&settings_path, &config)?;
        let (events, _) = broadcast::channel(256);
        let (notices, receiver) = mpsc::channel(256);
        Ok((
            Arc::new(Self {
                db: Mutex::new(db),
                settings: Mutex::new(config),
                data_dir: data_dir.to_path_buf(),
                config_dir: config_dir.to_path_buf(),
                executable,
                manifests: definitions,
                history: Mutex::new(vec![]),
                last_scan: Mutex::new(None),
                events,
                notices,
                started: Instant::now(),
                generation: AtomicU64::new(0),
                monitor: OnceLock::new(),
                models: OnceLock::new(),
                voice: OnceLock::new(),
            }),
            receiver,
        ))
    }
    pub fn config(&self) -> Value {
        self.settings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
    pub fn enabled(&self, tool: &str) -> bool {
        let s = self.config();
        s["privacy"]["sessionFileRead"] == true
            && !s["scan"]["ignoredToolIds"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == tool))
    }
    pub fn emit(&self, kind: &str, data: Value) {
        let _ = self
            .events
            .send(json!({"type":kind,"ts":queries::now(),"data":data}));
    }
    pub fn update_settings(&self, patch: &Value) -> io::Result<Value> {
        let mut current = self.settings.lock().map_err(|_| db_error())?;
        let next = settings::merge(&current, patch)?;
        settings::write_atomic(&self.config_dir.join("settings.json"), &next)?;
        *current = next.clone();
        self.generation.fetch_add(1, Ordering::AcqRel);
        drop(current);
        self.history.lock().map_err(|_| db_error())?.retain(|v| {
            next["privacy"]["sessionFileRead"] == true
                && !next["scan"]["ignoredToolIds"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|id| id == &v["toolId"]))
        });
        if let Some(monitor) = self.monitor.get().and_then(Weak::upgrade) {
            monitor.reconfigure();
        }
        if let Some(voice) = self.voice.get().and_then(Weak::upgrade) {
            voice.reconfigure();
        }
        self.emit("settings.changed", json!({}));
        Ok(next)
    }
    pub async fn ingest(
        &self,
        events: &[Event],
        checkpoint: Option<&Checkpoint>,
        announce: bool,
    ) -> Result<Vec<Transition>, String> {
        let transitions = {
            let config = self
                .settings
                .lock()
                .map_err(|_| "settings lock unavailable")?;
            if config["privacy"]["sessionFileRead"] != true
                || events.iter().any(|e| {
                    config["scan"]["ignoredToolIds"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|id| id == &e.tool_id))
                })
                || checkpoint.is_some_and(|cp| {
                    config["scan"]["ignoredToolIds"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|id| id == &cp.tool_id))
                })
            {
                return Ok(vec![]);
            }
            let mut db = self.db.lock().map_err(|_| "database lock unavailable")?;
            ingest_batch(
                &mut db,
                events,
                checkpoint,
                config["privacy"]["auditLog"] == true,
            )
            .map_err(|_| "事件事务提交失败")?
        };
        for result in &transitions {
            if let Some(event) = events.iter().find(|e| e.event_id == result.event_id) {
                self.emit("state.transition",json!({"sessionId":result.session_id,"prevState":result.previous.as_str(),"nextState":result.next.as_str(),"eventType":result.event_type.as_str(),"ts":event.occurred_at}));
                if announce {
                    self.notices
                        .send(event.clone())
                        .await
                        .map_err(|_| "提醒服务已经退出")?;
                }
            }
        }
        if !transitions.is_empty() {
            self.emit("board.updated", json!({}));
        }
        Ok(transitions)
    }
    pub fn overview(&self) -> Result<Value, String> {
        let db = self.db.lock().map_err(|_| "database lock unavailable")?;
        let counts = queries::counts(&db, None).map_err(|_| "数据库查询失败")?;
        let tools=queries::rows(&db,"SELECT count(*) AS total,sum(CASE WHEN detect_status='running' THEN 1 ELSE 0 END) AS running FROM tools",vec![]).map_err(|_|"数据库查询失败")?;
        Ok(
            json!({"attention":counts["waiting_human"].as_i64().unwrap_or(0)+counts["failed"].as_i64().unwrap_or(0)+counts["timeout"].as_i64().unwrap_or(0),"counts":counts,"tools":{"total":tools[0]["total"],"running":tools[0]["running"].as_i64().unwrap_or(0)},"adapters":self.manifests.len(),"lastScan":self.last_scan.lock().map_err(|_|"scan lock unavailable")?.clone(),"generatedAt":queries::now()}),
        )
    }
}

fn seed_rules(
    db: &Connection,
    settings: &mut Value,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let source: Value = serde_json::from_str(include_str!("../resources/voice-defaults.json"))?;
    let existing = queries::rows(
        db,
        "SELECT rule_id AS ruleId,scope_tool AS scopeTool,scope_event AS scopeEvent,action,template,priority FROM voice_rules",
        vec![],
    )?;
    let upgrade = settings["voice"]["rulesRevision"].as_u64().unwrap_or(0) < 3;
    let tx = db.unchecked_transaction()?;
    for rule in source["rules"].as_array().unwrap() {
        let matching = existing.iter().find(|row| {
            row["scopeTool"].is_null()
                && row["action"] != "mute"
                && source["legacy"].as_array().unwrap().iter().any(|old| {
                    old["scopeEvent"] == rule["scopeEvent"]
                        && ["scopeEvent", "action", "template", "priority"]
                            .iter()
                            .all(|key| row[key] == old[key])
                })
        });
        if !existing.is_empty() && (!upgrade || matching.is_none()) {
            continue;
        }
        let id = matching
            .map(|v| v["ruleId"].as_str().unwrap().to_owned())
            .unwrap_or_else(|| format!("*|{}", rule["scopeEvent"].as_str().unwrap()));
        tx.execute("INSERT INTO voice_rules(rule_id,scope_tool,scope_event,action,template,priority,updated_at) VALUES(?1,NULL,?2,?3,?4,?5,?6) ON CONFLICT(rule_id) DO UPDATE SET action=excluded.action,template=excluded.template,priority=excluded.priority,updated_at=excluded.updated_at",params![id,rule["scopeEvent"].as_str(),rule["action"].as_str(),rule["template"].as_str(),rule["priority"].as_str(),queries::now()])?;
    }
    tx.commit()?;
    settings["voice"]["rulesRevision"] = json!(3);
    Ok(())
}
