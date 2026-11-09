use crate::{
    capture,
    discovery::{self, Environment},
    queries,
    state::Runtime,
};
use agentcue_adapters::{digest, metadata};
use agentcue_store::engine::Event;
use chrono::{DateTime, Utc};
use rusqlite::params;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, Weak, atomic::Ordering},
    time::{Duration, Instant, SystemTime},
};
use tokio::{
    sync::{Mutex as AsyncMutex, watch},
    task::JoinHandle,
};
struct Tracked {
    tool: String,
    file: Option<PathBuf>,
    observation: Option<(SystemTime, u64)>,
    last_signal: Instant,
}
struct State {
    generation: u64,
    baseline: DateTime<Utc>,
    tracked: HashMap<String, Tracked>,
    issues: HashMap<String, String>,
}
pub struct Monitor {
    runtime: Weak<Runtime>,
    environment: Environment,
    state: Mutex<State>,
    capture_lock: AsyncMutex<()>,
    scan_lock: AsyncMutex<()>,
}
pub struct Handle {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Handle {
    pub async fn close(self) {
        let _ = self.stop.send(true);
        let mut task = self.task;
        if tokio::time::timeout(Duration::from_secs(3), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Monitor {
    pub fn new(runtime: &Arc<Runtime>, environment: Environment) -> Result<Arc<Self>, String> {
        let monitor = Arc::new(Self {
            runtime: Arc::downgrade(runtime),
            environment,
            state: Mutex::new(State {
                generation: runtime.generation.load(Ordering::Acquire),
                baseline: Utc::now(),
                tracked: HashMap::new(),
                issues: HashMap::new(),
            }),
            capture_lock: AsyncMutex::new(()),
            scan_lock: AsyncMutex::new(()),
        });
        runtime
            .monitor
            .set(Arc::downgrade(&monitor))
            .map_err(|_| "采集服务已经创建")?;
        Ok(monitor)
    }
    pub fn reconfigure(&self) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        let config = runtime.config();
        if let Ok(mut state) = self.state.lock() {
            state.generation = runtime.generation.load(Ordering::Acquire);
            state.baseline = Utc::now();
            state.issues.clear();
            state.tracked.retain(|_, t| {
                config["privacy"]["sessionFileRead"] == true && !ignored(&config, &t.tool)
            });
        }
    }
    fn current(&self, runtime: &Runtime, generation: u64, tool: &str) -> bool {
        runtime.generation.load(Ordering::Acquire) == generation && runtime.enabled(tool)
    }
    fn issue(&self, tool: &str, error: Option<String>) {
        if let Ok(mut s) = self.state.lock() {
            if let Some(error) = error {
                s.issues.insert(tool.into(), error);
            } else {
                s.issues.remove(tool);
            }
        }
    }
    pub fn start(self: &Arc<Self>) -> Handle {
        let monitor = self.clone();
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let Some(runtime) = monitor.runtime.upgrade() else {
                return;
            };
            let mut capture = tokio::time::interval(Duration::from_secs(5));
            capture.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut schedule = tokio::time::interval(Duration::from_secs(30));
            schedule.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let _ = monitor.scan().await;
            let mut last_auto = Instant::now();
            loop {
                tokio::select! {
                    _=stopped.changed()=>break,
                    _=capture.tick()=>{let _=monitor.capture().await;},
                    _=heartbeat.tick()=>{let _=monitor.tick().await;},
                    _=schedule.tick()=>{
                        let config=runtime.config();let hours=config["scan"]["autoIntervalHours"].as_f64().unwrap_or(0.0);
                        if hours>0.0&&last_auto.elapsed().as_secs_f64()>=hours*3600.0{let _=monitor.scan().await;last_auto=Instant::now();}
                    }
                }
            }
        });
        Handle { stop, task }
    }
    pub async fn scan(&self) -> Result<Value, String> {
        let runtime = self.runtime.upgrade().ok_or("采集服务已经退出")?;
        let _guard = match self.scan_lock.try_lock() {
            Ok(g) => g,
            Err(_) => {
                let guard = self.scan_lock.lock().await;
                drop(guard);
                return runtime
                    .last_scan
                    .lock()
                    .map_err(|_| "scan lock unavailable")?
                    .clone()
                    .ok_or_else(|| "扫描尚未完成".into());
            }
        };
        let generation = runtime.generation.load(Ordering::Acquire);
        let started = queries::now();
        let config = runtime.config();
        let processes = if self.environment.probe_system {
            discovery::process_snapshot().await.ok()
        } else {
            None
        };
        let mut results = vec![];
        let mut degraded = vec![];
        for manifest in &runtime.manifests {
            let id = manifest["id"].as_str().unwrap_or_default();
            if ignored(&config, id) || runtime.generation.load(Ordering::Acquire) != generation {
                continue;
            }
            let result =
                match discovery::probe(manifest, &self.environment, processes.as_deref()).await {
                    Ok(value) => value,
                    Err(_) => {
                        degraded.push(json!({"toolId":id,"reason":"安装识别暂不可用"}));
                        json!({"toolId":id,"status":"unknown"})
                    }
                };
            {
                let current = runtime
                    .settings
                    .lock()
                    .map_err(|_| "settings lock unavailable")?;
                if generation != runtime.generation.load(Ordering::Acquire) || ignored(&current, id)
                {
                    continue;
                }
                let db = runtime.db.lock().map_err(|_| "database lock unavailable")?;
                db.execute("UPDATE tools SET detect_status=?1,version=?2,config_path=?3,executable_path=?4,last_seen_at=?5 WHERE tool_id=?6",params![result["status"].as_str(),result["version"].as_str(),result["configPath"].as_str(),result["executablePath"].as_str(),queries::now(),id]).map_err(|_|"安装结果保存失败")?;
            }
            if let Some(reason) = result["degradedReason"].as_str() {
                degraded.push(json!({"toolId":id,"reason":reason}));
            }
            results.push(result);
        }
        if let Some(custom) = config["scan"]["customTools"].as_array() {
            for tool in custom {
                let id = tool["id"].as_str().unwrap_or_default();
                if ignored(&config, id) || runtime.generation.load(Ordering::Acquire) != generation
                {
                    continue;
                }
                let path = self
                    .environment
                    .expand(tool["configPath"].as_str().unwrap_or_default());
                let installed = tokio::fs::metadata(&path).await.is_ok();
                let current = runtime
                    .settings
                    .lock()
                    .map_err(|_| "settings lock unavailable")?;
                if generation != runtime.generation.load(Ordering::Acquire) || ignored(&current, id)
                {
                    continue;
                }
                let db = runtime.db.lock().map_err(|_| "database lock unavailable")?;
                let stamp = queries::now();
                db.execute("INSERT INTO tools(tool_id,name,adapter_id,detect_status,config_path,first_seen_at,last_seen_at) VALUES(?1,?2,'custom',?3,?4,?5,?5) ON CONFLICT(tool_id) DO UPDATE SET name=excluded.name,detect_status=excluded.detect_status,config_path=excluded.config_path,last_seen_at=excluded.last_seen_at",params![id,tool["name"].as_str(),if installed{"installed"}else{"not_installed"},path.to_string_lossy(),stamp]).map_err(|_|"自定义工具保存失败")?;
            }
        }
        let ingested = self.capture().await?;
        if let Ok(state) = self.state.lock() {
            for (id, reason) in &state.issues {
                degraded.push(json!({"toolId":id,"reason":reason}));
            }
        }
        let summary = json!({"scanId":format!("scan_{}",uuid::Uuid::new_v4()),"tools":results,"degraded":degraded,"ingestedEvents":ingested,"startedAt":started,"finishedAt":queries::now()});
        if generation == runtime.generation.load(Ordering::Acquire) {
            *runtime
                .last_scan
                .lock()
                .map_err(|_| "scan lock unavailable")? = Some(summary.clone());
            runtime.emit("scan.completed", summary.clone());
            runtime.emit("tools.updated", json!({}));
        }
        Ok(summary)
    }
    pub async fn capture(&self) -> Result<usize, String> {
        let Ok(_guard) = self.capture_lock.try_lock() else {
            return Ok(0);
        };
        let runtime = self.runtime.upgrade().ok_or("采集服务已经退出")?;
        let generation = runtime.generation.load(Ordering::Acquire);
        if self
            .state
            .lock()
            .map_err(|_| "monitor lock unavailable")?
            .generation
            != generation
        {
            self.reconfigure();
        }
        let baseline = self
            .state
            .lock()
            .map_err(|_| "monitor lock unavailable")?
            .baseline;
        let mut count = 0;
        for manifest in &runtime.manifests {
            let tool = manifest["id"].as_str().unwrap_or_default();
            if !self.current(&runtime, generation, tool) {
                continue;
            }
            self.issue(tool, None);
            let source = &manifest["sessionSource"];
            if manifest["sessionCapability"] == "metadata" && source["type"] == "json-index" {
                if let Err(e) = self.indexes(&runtime, manifest, generation).await {
                    self.issue(tool, Some(e));
                }
                continue;
            }
            if manifest["sessionCapability"] == "detect-only"
                || manifest["eventMapping"]
                    .as_object()
                    .is_none_or(|o| o.is_empty())
            {
                continue;
            }
            let Some(pattern) = self.environment.source_pattern(manifest) else {
                continue;
            };
            let mut files: HashSet<_> =
                discovery::files(&pattern, 500, || self.current(&runtime, generation, tool))
                    .await
                    .into_iter()
                    .collect();
            {
                let state = self.state.lock().map_err(|_| "monitor lock unavailable")?;
                for tracked in state.tracked.values() {
                    if tracked.tool == tool
                        && let Some(path) = &tracked.file
                    {
                        files.insert(path.clone());
                    }
                }
            }
            let mut files: Vec<_> = files.into_iter().collect();
            files.sort();
            for path in files {
                if !self.current(&runtime, generation, tool) {
                    break;
                }
                match capture::file(runtime.clone(), manifest, &path, baseline).await {
                    Ok(result) => {
                        count += result.ingested;
                        if result.bad_lines > 0 {
                            self.issue(tool, Some("已跳过格式错误的完整行；未记录行内容".into()));
                        }
                    }
                    Err(_) => self.issue(
                        tool,
                        Some("会话来源暂不可读或超过读取预算；下轮将重试".into()),
                    ),
                }
                self.track_file(&runtime, tool, &path)?;
            }
        }
        // Prune tracking on terminal transitions and privacy changes, independent of file checkpoints.
        let config = runtime.config();
        let active = self.active(&runtime)?;
        let ids: HashSet<_> = active
            .iter()
            .filter_map(|v| v["sessionId"].as_str())
            .collect();
        self.state
            .lock()
            .map_err(|_| "monitor lock unavailable")?
            .tracked
            .retain(|id, t| {
                ids.contains(id.as_str())
                    && config["privacy"]["sessionFileRead"] == true
                    && !ignored(&config, &t.tool)
            });
        Ok(count)
    }
    async fn indexes(
        &self,
        runtime: &Runtime,
        manifest: &Value,
        generation: u64,
    ) -> Result<(), String> {
        let tool = manifest["id"].as_str().unwrap_or_default();
        let mut records: HashMap<String, Value> = HashMap::new();
        let mut supported = 0;
        if let Some(indexes) = manifest["sessionSource"]["indexes"].as_array() {
            for index in indexes {
                if let Some(paths) = index["paths"].as_array() {
                    for entry in paths {
                        if !self.current(runtime, generation, tool) {
                            return Ok(());
                        }
                        let Some(raw) = self.environment.platform_path(entry) else {
                            continue;
                        };
                        let path = self.environment.expand(raw);
                        let bytes = match discovery::regular_file(&path, 16 * 1024 * 1024).await {
                            Ok(Some(v)) => v,
                            Ok(None) => continue,
                            Err(_) => continue,
                        };
                        if !self.current(runtime, generation, tool) {
                            return Ok(());
                        }
                        let Ok(value) = serde_json::from_slice(&bytes) else {
                            continue;
                        };
                        let Ok(parsed) = metadata::parse(
                            &value,
                            index["format"].as_str().unwrap_or_default(),
                            tool,
                        ) else {
                            continue;
                        };
                        supported += 1;
                        for row in parsed {
                            let id = row["sessionId"].as_str().unwrap_or_default().to_owned();
                            if records.get(&id).is_none_or(|old| {
                                old["updatedAt"].as_str() < row["updatedAt"].as_str()
                            }) {
                                records.insert(id, row);
                            }
                        }
                    }
                }
            }
        }
        let settings = runtime
            .settings
            .lock()
            .map_err(|_| "settings lock unavailable")?;
        if generation != runtime.generation.load(Ordering::Acquire)
            || settings["privacy"]["sessionFileRead"] != true
            || ignored(&settings, tool)
        {
            return Ok(());
        }
        let mut history = runtime
            .history
            .lock()
            .map_err(|_| "history lock unavailable")?;
        let before = history.clone();
        history.retain(|v| v["toolId"] != tool);
        history.extend(records.into_values());
        history.sort_by(|a, b| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()));
        if *history != before {
            runtime.emit("board.updated", json!({}));
        }
        if supported == 0 {
            return Err("未发现受支持的历史索引；未读取对话正文".into());
        }
        Ok(())
    }
    fn active(&self, runtime: &Runtime) -> Result<Vec<Value>, String> {
        let db = runtime.db.lock().map_err(|_| "database lock unavailable")?;
        queries::sessions(&db, &["running", "waiting_human"], None, None, None, 10000)
            .map_err(|_| "活跃任务查询失败".into())
    }
    fn track_file(
        &self,
        runtime: &Runtime,
        tool: &str,
        path: &std::path::Path,
    ) -> Result<(), String> {
        if !runtime.enabled(tool) {
            return Ok(());
        }
        let Some(project) = path
            .parent()
            .and_then(std::path::Path::file_name)
            .and_then(|s| s.to_str())
        else {
            return Ok(());
        };
        let Some(key) = path.file_stem().and_then(|s| s.to_str()) else {
            return Ok(());
        };
        let base = format!("{tool}:{project}:{key}");
        let prefix = format!("{base}:turn:");
        let active = self.active(runtime)?;
        let mut state = self.state.lock().map_err(|_| "monitor lock unavailable")?;
        for task in active {
            let id = task["sessionId"].as_str().unwrap_or_default();
            if id == base || id.starts_with(&prefix) {
                state
                    .tracked
                    .entry(id.into())
                    .or_insert_with(|| Tracked {
                        tool: tool.into(),
                        file: Some(path.into()),
                        observation: None,
                        last_signal: Instant::now(),
                    })
                    .file = Some(path.into());
            }
        }
        Ok(())
    }
    pub async fn tick(&self) -> Result<(), String> {
        let runtime = self.runtime.upgrade().ok_or("采集服务已经退出")?;
        let generation = runtime.generation.load(Ordering::Acquire);
        let config = runtime.config();
        if config["privacy"]["sessionFileRead"] != true {
            return Ok(());
        }
        let active = self.active(&runtime)?;
        let mut due = vec![];
        for task in active {
            let id = task["sessionId"].as_str().unwrap_or_default();
            let tool = task["toolId"].as_str().unwrap_or_default();
            if !self.current(&runtime, generation, tool) {
                continue;
            }
            let Some(manifest) = runtime.manifests.iter().find(|m| m["id"] == tool) else {
                continue;
            };
            if manifest["sessionCapability"] == "metadata"
                || manifest["sessionCapability"] == "detect-only"
            {
                continue;
            }
            let file = {
                let mut s = self.state.lock().map_err(|_| "monitor lock unavailable")?;
                s.tracked
                    .entry(id.into())
                    .or_insert_with(|| Tracked {
                        tool: tool.into(),
                        file: None,
                        observation: None,
                        last_signal: Instant::now(),
                    })
                    .file
                    .clone()
            };
            if let Some(path) = file
                && let Ok(stat) = tokio::fs::symlink_metadata(path).await
                && stat.is_file()
                && !stat.file_type().is_symlink()
                && self.current(&runtime, generation, tool)
            {
                let observation = Some((
                    stat.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    stat.len(),
                ));
                let mut s = self.state.lock().map_err(|_| "monitor lock unavailable")?;
                if let Some(t) = s.tracked.get_mut(id)
                    && t.observation != observation
                {
                    t.observation = observation;
                    t.last_signal = Instant::now();
                }
            }
            let timeout = task["currentState"] == "waiting_human"
                && task["updatedAt"]
                    .as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|t| Utc::now().signed_duration_since(t).num_minutes() >= 30);
            let lost = self
                .state
                .lock()
                .map_err(|_| "monitor lock unavailable")?
                .tracked
                .get(id)
                .is_some_and(|t| {
                    t.last_signal.elapsed()
                        >= Duration::from_secs(
                            manifest["heartbeat"]["intervalSec"].as_u64().unwrap_or(30) * 3,
                        )
                });
            if timeout || lost {
                due.push((task, timeout));
            }
        }
        let processes = if self.environment.probe_system && due.iter().any(|(_, timeout)| !*timeout)
        {
            discovery::process_snapshot().await.ok()
        } else {
            None
        };
        for (task, timeout) in due {
            let tool = task["toolId"].as_str().unwrap_or_default();
            let id = task["sessionId"].as_str().unwrap_or_default();
            if !self.current(&runtime, generation, tool) {
                continue;
            }
            if !timeout {
                let Some(snapshot) = processes.as_ref() else {
                    continue;
                };
                let manifest = runtime.manifests.iter().find(|m| m["id"] == tool).unwrap();
                let names = manifest["detect"]["processNames"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                if discovery::process_match(snapshot, names, self.environment.platform == "windows")
                    .is_some()
                {
                    if let Some(t) = self
                        .state
                        .lock()
                        .map_err(|_| "monitor lock unavailable")?
                        .tracked
                        .get_mut(id)
                    {
                        t.last_signal = Instant::now();
                    }
                    continue;
                }
            }
            let kind = if timeout {
                "task.timeout"
            } else {
                "heartbeat.lost"
            };
            let event=Event{event_id:format!("evt_{}",digest(&format!("{id}:{}:{kind}",task["updatedAt"].as_str().unwrap_or_default()))),session_id:id.into(),tool_id:tool.into(),event_type:kind.into(),occurred_at:queries::now(),actor:"system".into(),payload:serde_json::from_value(json!({"reason":if timeout{"等待用户超过 30 分钟"}else{"连续 3 个周期无信号且进程已退出"}})).unwrap(),schema_version:1};
            runtime.ingest(&[event], None, true).await?;
        }
        Ok(())
    }
}
fn ignored(config: &Value, id: &str) -> bool {
    config["scan"]["ignoredToolIds"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == id))
}
