//! User-triggered desktop preferences and update checks. No background network requests.
use agentcue_runtime::settings;
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};

#[cfg(any(not(windows), test))]
use std::path::PathBuf;

pub fn load(config: &Path) -> Value {
    let mut value = json!({"startHidden":false,"closeToTray":true,"autostart":false});
    let saved = fs::read(config.join("desktop.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    for key in ["startHidden", "closeToTray", "autostart"] {
        if let Some(v) = saved
            .as_ref()
            .and_then(|s| s.get(key))
            .filter(|v| v.is_boolean())
        {
            value[key] = v.clone();
        }
    }
    value
}
#[cfg(not(windows))]
fn home() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or("无法定位当前用户目录".into())
}
#[cfg(any(not(windows), test))]
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
#[cfg(any(not(windows), test))]
pub fn startup_entry(platform: &str, exe: &Path) -> Result<(PathBuf, String), String> {
    let path = exe.to_str().ok_or("应用路径不是有效文本")?;
    if !exe.is_absolute() || path.contains(['\r', '\n', '\0']) {
        return Err("应用路径无效".into());
    }
    match platform {
        "macos" => Ok((
            PathBuf::from("Library/LaunchAgents/com.agentcue.startup.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>com.agentcue.startup</string><key>ProgramArguments</key><array><string>{}</string><string>--background</string></array><key>RunAtLoad</key><true/></dict></plist>",
                xml(path)
            ),
        )),
        "linux" => Ok((
            PathBuf::from(".config/autostart/agentcue.desktop"),
            format!(
                "[Desktop Entry]\nType=Application\nName=AgentCue\nExec=\"{}\" --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
                path.replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('`', "\\`")
                    .replace('$', "\\$")
                    .replace('%', "%%")
            ),
        )),
        _ => Err("此平台使用注册表管理登录启动".into()),
    }
}
fn register(enabled: bool, exe: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let command = format!("\"{}\" --background", exe.display());
        if command.len() > 260 {
            return Err("应用路径过长，无法注册 Windows 登录启动".into());
        }
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let mut cmd = std::process::Command::new("reg.exe");
        cmd.creation_flags(0x08000000);
        if enabled {
            cmd.args([
                "add", key, "/v", "AgentCue", "/t", "REG_SZ", "/d", &command, "/f",
            ]);
        } else {
            cmd.args(["delete", key, "/v", "AgentCue", "/f"]);
        }
        let status = cmd.output().map_err(|_| "无法访问用户登录启动设置")?;
        if !status.status.success() {
            return Err("Windows 登录启动设置未成功更新".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let (relative, content) = startup_entry(std::env::consts::OS, exe)?;
        let mut target = home()?.join(relative);
        if cfg!(target_os = "linux")
            && let Some(config) = std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
        {
            target = config.join("autostart/agentcue.desktop");
        }
        if target
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err("登录启动文件不能是符号链接".into());
        }
        if enabled {
            fs::create_dir_all(target.parent().ok_or("启动目录无效")?)
                .map_err(|_| "无法创建登录启动目录")?;
            fs::write(&target, content).map_err(|_| "无法写入登录启动设置")?;
        } else {
            match fs::remove_file(&target) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("无法关闭登录启动".into()),
            }
        }
        Ok(())
    }
}
pub fn save(config: &Path, exe: &Path, value: &Value, isolated: bool) -> Result<Value, String> {
    let mut next = load(config);
    for key in ["startHidden", "closeToTray", "autostart"] {
        if let Some(v) = value.get(key) {
            if !v.is_boolean() {
                return Err("应用选项须为开关值".into());
            }
            next[key] = v.clone();
        }
    }
    let old = load(config);
    if old["autostart"] != next["autostart"] {
        if isolated {
            return Err("隔离预览不修改系统登录启动设置".into());
        }
        register(next["autostart"] == true, exe)?;
    }
    if settings::write_atomic(&config.join("desktop.json"), &next).is_err() {
        if old["autostart"] != next["autostart"] {
            let _ = register(old["autostart"] == true, exe);
        }
        return Err("应用设置保存失败".into());
    }
    Ok(next)
}
fn version(s: &str) -> Option<(u64, u64, u64)> {
    let parts = s
        .trim_start_matches('v')
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (parts.len() == 3).then(|| (parts[0], parts[1], parts[2]))
}
pub async fn check_update() -> Result<Value, String> {
    let mut response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "更新检查不可用")?
        .get("https://api.github.com/repos/ideshun/AgentCue/releases/latest")
        .header("User-Agent", "AgentCue-update-check")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "无法连接 GitHub，请检查网络后重试")?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub 更新检查失败（HTTP {}），请稍后重试或打开发布页查看",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|n| n > 1024 * 1024) {
        return Err("更新响应过大".into());
    }
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|_| "更新响应读取失败")? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("更新响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "更新响应无效")?;
    let tag = data["tag_name"]
        .as_str()
        .filter(|s| version(s).is_some())
        .ok_or("正式版本号无效")?;
    let current = version(env!("CARGO_PKG_VERSION")).ok_or("当前版本号无效")?;
    let suffix = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "_aarch64.dmg",
        ("macos", "x86_64") => "_x64.dmg",
        ("windows", "x86_64") => "_x64-setup.exe",
        ("linux", "x86_64") => "_amd64.AppImage",
        _ => "unsupported",
    };
    let download = data["assets"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|a| a["name"].as_str().is_some_and(|s| s.ends_with(suffix)))
        })
        .and_then(|v| v["browser_download_url"].as_str())
        .filter(|s| s.starts_with("https://github.com/ideshun/AgentCue/releases/download/"));
    Ok(
        json!({"current":env!("CARGO_PKG_VERSION"),"latest":tag,"available":version(tag).is_some_and(|v|v>current),"checkedAt":agentcue_runtime::queries::now(),"downloadUrl":download,"releaseUrl":format!("https://github.com/ideshun/AgentCue/releases/tag/{tag}"),"notes":data["body"].as_str().unwrap_or("").chars().take(6000).collect::<String>()}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_native_preferences_keep_safe_defaults() {
        let dir =
            std::env::temp_dir().join(format!("agentcue-desktop-prefs-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("desktop.json"), "[]").unwrap();
        assert_eq!(load(&dir)["closeToTray"], true);
        fs::write(
            dir.join("desktop.json"),
            r#"{"startHidden":"false","autostart":true}"#,
        )
        .unwrap();
        assert_eq!(load(&dir)["startHidden"], false);
        assert_eq!(load(&dir)["autostart"], true);
        assert!(
            save(
                &dir,
                &std::env::current_exe().unwrap(),
                &json!({"autostart":false}),
                true
            )
            .is_err()
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn startup_paths_are_quoted_and_versions_compare_numerically() {
        let (_, plist) = startup_entry(
            "macos",
            &std::env::temp_dir().join("A & B.app/Contents/MacOS/A"),
        )
        .unwrap();
        assert!(plist.contains("A &amp; B"));
        let (_, desktop) = startup_entry("linux", &std::env::temp_dir().join("A%20/app")).unwrap();
        assert!(desktop.contains("A%%20"));
        assert!(version("v1.10.0") > version("v1.9.9"));
        assert_eq!(version("v1.0.0-beta.1"), None);
    }
}
