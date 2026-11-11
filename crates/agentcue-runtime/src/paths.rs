//! Stable data-directory identity shared by the desktop host, Hooks and MCP.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

pub const DATA_DIR_NAME: &str = "AgentCue";
pub const LEGACY_DATA_DIR_NAME: &str = "AI Workflow Monitor";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub legacy_data_dir: Option<PathBuf>,
}

impl AppPaths {
    /// Explicit data directories are isolated from the normal profile and do not migrate data.
    pub fn for_data_dir(data_dir: PathBuf) -> Self {
        Self {
            config_dir: data_dir.clone(),
            data_dir,
            legacy_data_dir: None,
        }
    }
}

fn absolute(value: Option<&Path>, fallback: PathBuf) -> PathBuf {
    value
        .filter(|path| path.is_absolute())
        .map_or(fallback, Path::to_path_buf)
}

pub fn app_paths(
    platform: &str,
    home: &Path,
    local_appdata: Option<&Path>,
    roaming_appdata: Option<&Path>,
    xdg_data_home: Option<&Path>,
    xdg_config_home: Option<&Path>,
) -> AppPaths {
    match platform {
        "macos" => {
            let support = home.join("Library/Application Support");
            AppPaths {
                data_dir: support.join(DATA_DIR_NAME),
                config_dir: support.join(DATA_DIR_NAME),
                legacy_data_dir: Some(support.join(LEGACY_DATA_DIR_NAME)),
            }
        }
        "windows" => {
            let local = absolute(local_appdata, home.join("AppData/Local"));
            let roaming = absolute(roaming_appdata, home.join("AppData/Roaming"));
            AppPaths {
                data_dir: local.join(DATA_DIR_NAME),
                config_dir: local.join(DATA_DIR_NAME),
                legacy_data_dir: Some(roaming.join(LEGACY_DATA_DIR_NAME)),
            }
        }
        _ => {
            let data = absolute(xdg_data_home, home.join(".local/share")).join("agentcue");
            let config = absolute(xdg_config_home, home.join(".config")).join("agentcue");
            let legacy = absolute(xdg_config_home, home.join(".config")).join(LEGACY_DATA_DIR_NAME);
            AppPaths {
                data_dir: data,
                config_dir: config,
                legacy_data_dir: Some(legacy),
            }
        }
    }
}

pub fn default_app_paths() -> io::Result<AppPaths> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "无法确定本机用户目录"))?;
    let env_path = |key: &str| {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    Ok(app_paths(
        std::env::consts::OS,
        Path::new(&home),
        env_path("LOCALAPPDATA").as_deref(),
        env_path("APPDATA").as_deref(),
        env_path("XDG_DATA_HOME").as_deref(),
        env_path("XDG_CONFIG_HOME").as_deref(),
    ))
}

pub fn default_data_dir() -> io::Result<PathBuf> {
    Ok(default_app_paths()?.data_dir)
}

pub fn open_lock(directory: &Path) -> io::Result<File> {
    let path = directory.join("agentcue.lock");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "AgentCue 锁文件不是普通文件",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "AgentCue 锁文件不是普通文件",
        ));
    }
    Ok(file)
}

/// Move legacy entries without following symlinks or overwriting data at the new location.
/// Same-volume entries are renamed, so large downloaded models are not duplicated.
pub fn migrate_legacy(paths: &AppPaths) -> io::Result<()> {
    let Some(legacy_dir) = paths.legacy_data_dir.as_deref() else {
        return Ok(());
    };
    if legacy_dir == paths.data_dir {
        return Ok(());
    }
    let legacy_metadata = match fs::symlink_metadata(legacy_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !legacy_metadata.is_dir() || legacy_metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "旧数据目录不是安全的普通目录，已停止迁移以保护数据",
        ));
    }
    fs::create_dir_all(&paths.data_dir)?;
    fs::create_dir_all(&paths.config_dir)?;

    let legacy_lock = open_lock(legacy_dir)
        .map_err(|_| io::Error::other("无法检查旧版 AgentCue 是否仍在运行"))?;
    legacy_lock.try_lock().map_err(|_| {
        io::Error::new(
            io::ErrorKind::WouldBlock,
            "旧版 AgentCue 仍在使用原数据目录，请完全退出旧版后再启动新版",
        )
    })?;

    for entry in fs::read_dir(legacy_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == "agentcue.lock" {
            continue;
        }
        let source = entry.path();
        let destination = if name == "settings.json" {
            paths.config_dir.join(name)
        } else {
            paths.data_dir.join(name)
        };
        migrate_entry(&source, &destination)?;
    }

    remap_voice_reference(
        &paths.config_dir.join("settings.json"),
        legacy_dir,
        &paths.data_dir,
    )?;

    drop(legacy_lock);
    let _ = fs::remove_file(legacy_dir.join("agentcue.lock"));
    let _ = fs::remove_dir(legacy_dir);
    Ok(())
}

fn migrate_entry(source: &Path, destination: &Path) -> io::Result<()> {
    let source_metadata = fs::symlink_metadata(source)?;
    if source_metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "旧数据目录包含符号链接，已停止迁移以避免读取目录外的数据",
        ));
    }

    match fs::symlink_metadata(destination) {
        Ok(destination_metadata) => {
            if source_metadata.is_dir() && destination_metadata.is_dir() {
                for entry in fs::read_dir(source)? {
                    let entry = entry?;
                    migrate_entry(&entry.path(), &destination.join(entry.file_name()))?;
                }
                let _ = fs::remove_dir(source);
                return Ok(());
            }
            if source_metadata.is_file() && destination_metadata.is_file() {
                // Prefer existing new-profile data; leave the legacy copy for recovery.
                return Ok(());
            }
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("新旧数据项冲突，原文件已保留：{}", source.display()),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    if source_metadata.is_dir() {
        ensure_no_symlinks(source)?;
    }
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if is_cross_device(&error) => copy_entry(source, destination),
        Err(error) => Err(error),
    }
}

fn ensure_no_symlinks(directory: &Path) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "旧数据目录包含符号链接，已停止迁移以避免读取目录外的数据",
            ));
        }
        if metadata.is_dir() {
            ensure_no_symlinks(&path)?;
        }
    }
    Ok(())
}

fn copy_entry(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "拒绝复制符号链接",
        ));
    }
    if metadata.is_dir() {
        match fs::create_dir(destination) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "旧数据目录包含不支持的文件类型",
        ));
    }
    if destination.exists() {
        return Ok(());
    }

    let temporary =
        destination.with_file_name(format!(".agentcue-migrate-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut input = File::open(source)?;
        let mut output_options = OpenOptions::new();
        output_options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            output_options.mode(0o600);
        }
        let mut output = output_options.open(&temporary)?;
        io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        drop(output);
        match fs::rename(&temporary, destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && destination.exists() => {
                Ok(())
            }
            Err(error) => Err(error),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn is_cross_device(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(17)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = error;
        false
    }
}

fn remap_voice_reference(
    settings_path: &Path,
    legacy_dir: &Path,
    new_data_dir: &Path,
) -> io::Result<()> {
    let raw = match fs::read(settings_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut settings: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(settings) => settings,
        Err(_) => return Ok(()),
    };
    let Some(path) = settings["voice"]["zipvoiceReferencePath"].as_str() else {
        return Ok(());
    };
    let old = Path::new(path);
    let Ok(relative) = old.strip_prefix(legacy_dir) else {
        return Ok(());
    };
    settings["voice"]["zipvoiceReferencePath"] = new_data_dir
        .join(relative)
        .to_string_lossy()
        .into_owned()
        .into();
    crate::settings::write_atomic(settings_path, &settings)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub api_port: u16,
    pub token: String,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub started_at: String,
}
pub fn read_runtime(dir: &Path) -> io::Result<RuntimeInfo> {
    let path = dir.join("runtime.json");
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.len() > 8192 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "运行时握手文件无效",
        ));
    }
    let value: RuntimeInfo = serde_json::from_slice(&fs::read(path)?)?;
    if value.api_port == 0
        || value.token.is_empty()
        || value.token.len() > 1024
        || value.token.chars().any(char::is_control)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "运行时握手信息无效",
        ));
    }
    Ok(value)
}
pub fn write_runtime(dir: &Path, value: &RuntimeInfo) -> io::Result<()> {
    crate::settings::write_atomic(&dir.join("runtime.json"), &serde_json::to_value(value)?)
}
