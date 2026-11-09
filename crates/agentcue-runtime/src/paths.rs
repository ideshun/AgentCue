//! Stable data-directory identity shared by the desktop host, Hooks and MCP.
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub const DATA_DIR_NAME: &str = "AI Workflow Monitor";
pub fn data_dir(
    platform: &str,
    home: &Path,
    appdata: Option<&Path>,
    xdg: Option<&Path>,
) -> PathBuf {
    match platform {
        "macos" => home.join("Library/Application Support").join(DATA_DIR_NAME),
        "windows" => appdata
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join(DATA_DIR_NAME),
        _ => xdg
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".config"))
            .join(DATA_DIR_NAME),
    }
}
pub fn default_data_dir() -> io::Result<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "无法确定本机用户目录"))?;
    Ok(data_dir(
        std::env::consts::OS,
        Path::new(&home),
        std::env::var_os("APPDATA").as_deref().map(Path::new),
        std::env::var_os("XDG_CONFIG_HOME")
            .as_deref()
            .map(Path::new),
    ))
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
