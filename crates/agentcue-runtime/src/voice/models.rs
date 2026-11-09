//! Only explicit UI/API download actions start network requests; status inspection is local.
use super::{Cancellation, audio};
use crate::state::Runtime;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tokio::{io::AsyncWriteExt, process::Command, sync::watch, task::JoinHandle};
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredFile {
    pub name: String,
    pub min_bytes: u64,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraFile {
    pub name: String,
    pub url: String,
    pub min_bytes: u64,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub kind: String,
    pub dir_name: String,
    pub archive_url: String,
    pub required_files: Vec<RequiredFile>,
    #[serde(default)]
    pub required_dirs: Vec<String>,
    #[serde(default)]
    pub extra_files: Vec<ExtraFile>,
}
pub fn specs() -> Vec<Spec> {
    serde_json::from_str(include_str!("../../resources/model-specs.json"))
        .expect("embedded model specs")
}
struct Job {
    status: Value,
    cancel: Option<watch::Sender<u64>>,
    task: Option<JoinHandle<()>>,
    last_progress: Instant,
}
pub struct Models {
    pub root: PathBuf,
    specs: Vec<Spec>,
    jobs: Mutex<HashMap<String, Job>>,
    runtime: Weak<Runtime>,
}
impl Models {
    pub fn new(root: PathBuf, runtime: Weak<Runtime>, specs: Vec<Spec>) -> Arc<Self> {
        let jobs = specs
            .iter()
            .map(|s| {
                (
                    s.kind.clone(),
                    Job {
                        status: json!({"state":"missing","kind":s.kind}),
                        cancel: None,
                        task: None,
                        last_progress: Instant::now(),
                    },
                )
            })
            .collect();
        let manager = Arc::new(Self {
            root,
            specs,
            jobs: Mutex::new(jobs),
            runtime,
        });
        if let Some(runtime) = manager.runtime.upgrade() {
            let _ = runtime.models.set(Arc::downgrade(&manager));
        }
        manager
    }
    pub fn directory(&self, kind: &str) -> Option<PathBuf> {
        self.specs
            .iter()
            .find(|s| s.kind == kind)
            .map(|s| self.root.join(&s.dir_name))
    }
    pub fn status(&self, kind: &str) -> Value {
        let Some(spec) = self.specs.iter().find(|s| s.kind == kind) else {
            return json!({"state":"error","kind":kind,"error":"本地模型种类无效"});
        };
        let status = self
            .jobs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(kind)
            .map(|j| j.status.clone())
            .unwrap_or_else(|| json!({"state":"missing","kind":kind}));
        if status["state"] == "missing" && inspect(&self.root.join(&spec.dir_name), spec).is_ok() {
            json!({"state":"ready","kind":kind})
        } else {
            status
        }
    }
    pub fn cancel(&self, kind: &str) {
        if let Ok(jobs) = self.jobs.lock()
            && let Some(cancel) = jobs.get(kind).and_then(|j| j.cancel.as_ref())
        {
            let _ = cancel.send(1);
        }
    }
    pub fn start(self: &Arc<Self>, kind: &str) -> Result<(), String> {
        let spec = self
            .specs
            .iter()
            .find(|s| s.kind == kind)
            .ok_or("本地模型种类无效")?
            .clone();
        if self.status(kind)["state"] == "ready" {
            return Ok(());
        }
        let mut jobs = self.jobs.lock().map_err(|_| "model lock unavailable")?;
        let job = jobs.get_mut(kind).ok_or("本地模型种类无效")?;
        if job.task.as_ref().is_some_and(|t| !t.is_finished()) {
            return Ok(());
        }
        let (cancel, receiver) = watch::channel(0);
        job.cancel = Some(cancel);
        job.status =
            json!({"state":"downloading","kind":kind,"bytes":0,"totalBytes":0,"percent":0});
        let manager = self.clone();
        job.task = Some(tokio::spawn(async move {
            manager
                .run(
                    spec,
                    Cancellation {
                        receiver,
                        generation: 0,
                    },
                )
                .await;
        }));
        if let Some(runtime) = self.runtime.upgrade() {
            runtime.emit("model.progress", job.status.clone());
        }
        Ok(())
    }
    fn publish(&self, kind: &str, mut status: Value, force: bool) {
        status["kind"] = json!(kind);
        if let Ok(mut jobs) = self.jobs.lock()
            && let Some(job) = jobs.get_mut(kind)
        {
            job.status = status.clone();
            if force || job.last_progress.elapsed() >= Duration::from_millis(500) {
                job.last_progress = Instant::now();
                if let Some(runtime) = self.runtime.upgrade() {
                    runtime.emit("model.progress", status);
                }
            }
        }
    }

    async fn run(self: Arc<Self>, spec: Spec, mut cancel: Cancellation) {
        let archive = self.root.join(format!("{}.tar.bz2", spec.dir_name));
        let work = self
            .root
            .join(format!(".{}-extract-{}", spec.kind, uuid::Uuid::new_v4()));
        let deadline = Instant::now() + Duration::from_secs(30 * 60);
        let result = async {
            tokio::fs::create_dir_all(&self.root)
                .await
                .map_err(|_| "模型目录创建失败".to_owned())?;
            self.download(
                &spec.kind,
                &spec.archive_url,
                &archive,
                &mut cancel,
                deadline,
            )
            .await?;
            if cancel.cancelled() {
                return Err("下载已取消".into());
            }
            tokio::fs::create_dir(&work)
                .await
                .map_err(|_| "模型解压目录创建失败".to_owned())?;
            self.publish(
                &spec.kind,
                json!({"state":"extracting","percent":100}),
                true,
            );
            let mut command = Command::new("tar");
            command.arg("-xjf").arg(&archive).arg("-C").arg(&work);
            let timeout = deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(10 * 60));
            audio::command(command, None, 0, cancel.clone(), timeout)
                .await
                .map_err(|s| s.replace("语音", "模型解压"))?;
            let inner = work.join(&spec.dir_name);
            for extra in &spec.extra_files {
                self.download(
                    &spec.kind,
                    &extra.url,
                    &inner.join(&extra.name),
                    &mut cancel,
                    deadline,
                )
                .await?;
            }
            inspect(&inner, &spec)?;
            if cancel.cancelled() {
                return Err("下载已取消".into());
            }
            let target = self.root.join(&spec.dir_name);
            let backup =
                self.root
                    .join(format!(".{}-previous-{}", spec.kind, uuid::Uuid::new_v4()));
            let previous = tokio::fs::symlink_metadata(&target).await.is_ok();
            if previous {
                tokio::fs::rename(&target, &backup)
                    .await
                    .map_err(|_| "旧模型目录暂不可替换".to_owned())?;
            }
            if tokio::fs::rename(&inner, &target).await.is_err() {
                if previous {
                    let _ = tokio::fs::rename(&backup, &target).await;
                }
                return Err("模型安装失败，已保留旧模型".into());
            }
            if previous {
                let _ = tokio::fs::remove_dir_all(backup).await;
            }
            Ok::<(), String>(())
        }
        .await;
        let _ = tokio::fs::remove_dir_all(work).await;
        let _ = tokio::fs::remove_file(archive).await;
        match result{
            Ok(())=>self.publish(&spec.kind,json!({"state":"ready"}),true),
            Err(_) if cancel.cancelled()=>self.publish(&spec.kind,json!({"state":"missing"}),true),
            Err(error)=>self.publish(&spec.kind,json!({"state":"error","error":error.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect::<String>()}),true),
        }
        if let Ok(mut jobs) = self.jobs.lock()
            && let Some(job) = jobs.get_mut(&spec.kind)
        {
            job.cancel = None;
        }
    }
    async fn download(
        &self,
        kind: &str,
        url: &str,
        path: &Path,
        cancel: &mut Cancellation,
        deadline: Instant,
    ) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|_| "模型下载服务不可用")?;
        let part = PathBuf::from(format!("{}.part", path.to_string_lossy()));
        let task = async {
            let mut offset = match tokio::fs::symlink_metadata(&part).await {
                Ok(v) if v.is_file() && !v.file_type().is_symlink() => v.len(),
                Ok(_) => return Err("模型下载缓存不是普通文件".into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
                Err(_) => return Err("模型下载缓存不可读".into()),
            };
            let mut response = None;
            for _ in 0..2 {
                let mut request = client.get(url);
                if offset > 0 {
                    request = request.header("range", format!("bytes={offset}-"));
                }
                let value = request
                    .send()
                    .await
                    .map_err(|_| "模型下载连接失败，请检查网络后重试")?;
                if value.status().as_u16() == 416 && offset > 0 {
                    let _ = tokio::fs::remove_file(&part).await;
                    offset = 0;
                    continue;
                }
                if !value.status().is_success() {
                    return Err(format!("模型下载失败：HTTP {}", value.status().as_u16()));
                }
                if value.status().as_u16() != 206 {
                    offset = 0;
                } else {
                    let range = value
                        .headers()
                        .get("content-range")
                        .and_then(|s| s.to_str().ok())
                        .unwrap_or_default();
                    if !range.starts_with(&format!("bytes {offset}-")) {
                        return Err("模型下载的断点范围不匹配，请重试".into());
                    }
                }
                response = Some(value);
                break;
            }
            let mut response = response.ok_or("模型下载未能启动")?;
            let total = response
                .headers()
                .get("content-range")
                .and_then(|s| s.to_str().ok())
                .and_then(|s| s.rsplit('/').next())
                .and_then(|s| s.parse::<u64>().ok())
                .or_else(|| response.content_length().map(|n| n + offset))
                .unwrap_or(0);
            if total > 2 * 1024 * 1024 * 1024 {
                return Err("模型包超过支持的大小上限".into());
            }
            let mut options = tokio::fs::OpenOptions::new();
            options
                .write(true)
                .create(true)
                .append(offset > 0)
                .truncate(offset == 0);
            #[cfg(unix)]
            {
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut file = options
                .open(&part)
                .await
                .map_err(|_| "模型下载缓存无法写入")?;
            let mut received = offset;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "模型下载中断；重试可继续下载")?
            {
                received += chunk.len() as u64;
                if received > 2 * 1024 * 1024 * 1024 {
                    return Err("模型包超过支持的大小上限".into());
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|_| "模型下载写入失败，请检查可用空间")?;
                self.publish(kind,json!({"state":"downloading","bytes":received,"totalBytes":total,"percent":(received*100).checked_div(total).unwrap_or(0).min(99)}),false);
            }
            if total > 0 && received != total {
                return Err("模型下载不完整；重试可继续下载".into());
            }
            file.sync_all().await.map_err(|_| "模型下载保存失败")?;
            drop(file);
            tokio::fs::rename(&part, path)
                .await
                .map_err(|_| "模型下载文件无法就位")?;
            Ok::<(), String>(())
        };
        tokio::select! {
            _=cancel.wait()=>Err("下载已取消".into()),
            result=tokio::time::timeout(deadline.saturating_duration_since(Instant::now()),task)=>result.unwrap_or_else(|_|Err("下载超时（30 分钟），请检查网络后重试".into())),
        }
    }
    pub async fn close(&self) {
        let tasks = {
            let mut jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
            jobs.values_mut()
                .filter_map(|j| {
                    if let Some(c) = &j.cancel {
                        let _ = c.send(1);
                    }
                    j.task.take()
                })
                .collect::<Vec<_>>()
        };
        for mut task in tasks {
            if tokio::time::timeout(Duration::from_secs(3), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }
}
pub fn inspect(dir: &Path, spec: &Spec) -> Result<(), String> {
    for file in &spec.required_files {
        let info = dir
            .join(&file.name)
            .metadata()
            .map_err(|_| format!("模型缺少 {}", file.name))?;
        if !info.is_file() || info.len() < file.min_bytes {
            return Err(format!("模型文件 {} 不完整", file.name));
        }
    }
    for directory in &spec.required_dirs {
        if !dir.join(directory).is_dir() {
            return Err(format!("模型缺少目录 {directory}"));
        }
    }
    for file in &spec.extra_files {
        let info = dir
            .join(&file.name)
            .metadata()
            .map_err(|_| format!("模型缺少 {}", file.name))?;
        if !info.is_file() || info.len() < file.min_bytes {
            return Err(format!("模型文件 {} 不完整", file.name));
        }
    }
    Ok(())
}
