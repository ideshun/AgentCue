use agentcue_runtime::{
    api,
    discovery::Environment,
    monitor::{Handle as MonitorHandle, Monitor},
    paths::{self, RuntimeInfo},
    queries,
    state::Runtime,
    voice::{
        backends::Backends,
        models::{self, Models},
        service::Voice,
    },
};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

pub struct Services {
    pub runtime: Arc<Runtime>,
    pub monitor: Arc<Monitor>,
    pub voice: Arc<Voice>,
    pub models: Arc<Models>,
    pub info: RuntimeInfo,
    api: Mutex<Option<api::ApiHandle>>,
    timer: Mutex<Option<MonitorHandle>>,
    _data_lock: File,
}

impl Services {
    pub async fn start(
        data_dir: PathBuf,
        executable: PathBuf,
        isolated: bool,
    ) -> Result<Self, String> {
        fs::create_dir_all(&data_dir).map_err(|_| "无法创建 AgentCue 数据目录")?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(data_dir.join("agentcue.lock"))
            .map_err(|_| "无法锁定 AgentCue 数据目录")?;
        lock.try_lock()
            .map_err(|_| "另一个 AgentCue 实例正在使用此数据目录")?;
        if let Ok(info) = paths::read_runtime(&data_dir) {
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .map_err(|_| "本机连接不可用")?;
            let url = format!("http://127.0.0.1:{}/api/v1/health", info.api_port);
            if client
                .get(url)
                .bearer_auth(info.token)
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                return Err("此数据目录已由运行中的 AgentCue 使用，请先退出旧版应用".into());
            }
        }
        let database = agentcue_store::open::open_database(&data_dir.join("awm.db"))
            .map_err(|e| format!("无法打开 AgentCue 数据库：{e}"))?;
        let integration_entry = if cfg!(target_os = "linux") {
            std::env::var_os("APPIMAGE")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute() && path.is_file())
                .unwrap_or_else(|| executable.clone())
        } else {
            executable.clone()
        };
        let (runtime, notices) = Runtime::new(database.connection, &data_dir, integration_entry)
            .map_err(|e| format!("无法载入 AgentCue：{e}"))?;
        let environment = if isolated {
            let home = data_dir.join("fixture-home");
            let vars = [
                "HOME",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
                "XDG_CONFIG_HOME",
            ]
            .into_iter()
            .map(|name| (name.to_owned(), home.to_string_lossy().into_owned()))
            .collect::<HashMap<_, _>>();
            Environment {
                platform: std::env::consts::OS.into(),
                home,
                vars,
                probe_system: false,
            }
        } else {
            Environment::system(&runtime.manifests).map_err(|e| e.to_string())?
        };
        let monitor = Monitor::new(&runtime, environment)?;
        let models = Models::new(
            data_dir.join("models"),
            Arc::downgrade(&runtime),
            models::specs(),
        );
        let worker = executable.with_file_name(if cfg!(windows) {
            "agentcue-tts.exe"
        } else {
            "agentcue-tts"
        });
        let voice = Voice::start(
            &runtime,
            notices,
            Arc::new(Backends::new(models.clone(), worker)),
        )?;
        let api = api::start(runtime.clone(), 0)
            .await
            .map_err(|_| "无法启动本机控制服务")?;
        let info = RuntimeInfo {
            api_port: api.port,
            token: api.token.clone(),
            pid: std::process::id(),
            started_at: queries::now(),
        };
        if paths::write_runtime(&data_dir, &info).is_err() {
            let _ = api.close().await;
            voice.close().await;
            return Err("无法保存本机连接信息".into());
        }
        Ok(Self {
            runtime,
            monitor,
            voice,
            models,
            info,
            api: Mutex::new(Some(api)),
            timer: Mutex::new(None),
            _data_lock: lock,
        })
    }

    pub fn start_monitor(&self) {
        let mut timer = self.timer.lock().unwrap_or_else(|p| p.into_inner());
        if timer.is_none() {
            *timer = Some(self.monitor.start());
        }
    }

    pub async fn close(&self) {
        let timer = self.timer.lock().unwrap_or_else(|p| p.into_inner()).take();
        let api = self.api.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(timer) = timer {
            timer.close().await;
        }
        // Stop playback first so a pending preview cannot keep the HTTP service open.
        self.voice.close().await;
        if let Some(api) = api {
            let _ = api.close().await;
        }
        self.models.close().await;
        let path = self.runtime.data_dir.join("runtime.json");
        if paths::read_runtime(&self.runtime.data_dir)
            .is_ok_and(|info| info.pid == self.info.pid && info.token == self.info.token)
        {
            let _ = fs::remove_file(path);
        }
    }
}
