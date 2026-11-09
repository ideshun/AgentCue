//! Bounded discovery of declared directories, without following directory symlinks.
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use tokio::{fs, io::AsyncReadExt, process::Command};
#[derive(Clone)]
pub struct Environment {
    pub platform: String,
    pub home: PathBuf,
    pub vars: HashMap<String, String>,
    pub probe_system: bool,
}
impl Environment {
    pub fn system(manifests: &[Value]) -> std::io::Result<Self> {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .ok_or_else(|| std::io::Error::other("无法确定本机用户目录"))?;
        let mut vars = HashMap::new();
        for key in ["USERPROFILE", "APPDATA", "XDG_CONFIG_HOME"] {
            if let Ok(value) = std::env::var(key) {
                vars.insert(key.into(), value);
            }
        }
        for manifest in manifests {
            if let Some(entries) = manifest["detect"]["configPaths"].as_array() {
                for entry in entries {
                    if let Some(keys) = entry["envOverride"].as_array() {
                        for key in keys.iter().filter_map(Value::as_str) {
                            if let Ok(value) = std::env::var(key) {
                                vars.insert(key.into(), value);
                            }
                        }
                    }
                }
            }
        }
        Ok(Self {
            platform: std::env::consts::OS.into(),
            home: home.into(),
            vars,
            probe_system: true,
        })
    }
    pub fn platform_path<'a>(&self, entry: &'a Value) -> Option<&'a str> {
        entry[match self.platform.as_str() {
            "macos" => "mac",
            "windows" => "win",
            _ => "linux",
        }]
        .as_str()
    }
    pub fn expand(&self, raw: &str) -> PathBuf {
        let value = if let Some(s) = raw.strip_prefix('~') {
            self.home
                .join(s.trim_start_matches(['\\', '/']))
                .to_string_lossy()
                .into_owned()
        } else {
            raw.into()
        };
        let mut out = String::new();
        let mut rest = value.as_str();
        while let Some(start) = rest.find('%') {
            out.push_str(&rest[..start]);
            let suffix = &rest[start + 1..];
            let Some(end) = suffix.find('%') else {
                out.push_str(&rest[start..]);
                rest = "";
                break;
            };
            let name = &suffix[..end];
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                out.push_str(self.vars.get(name).map(String::as_str).unwrap_or_default());
            } else {
                out.push_str(&rest[start..start + end + 2]);
            }
            rest = &suffix[end + 1..];
        }
        out.push_str(rest);
        PathBuf::from(out)
    }
    /// Only environment overrides explicitly declared by this adapter may rebase its session root.
    pub fn source_pattern(&self, manifest: &Value) -> Option<PathBuf> {
        let raw = manifest["sessionSource"]["pathPattern"].as_str()?;
        let pattern = self.expand(raw);
        if let Some(configs) = manifest["detect"]["configPaths"].as_array() {
            for entry in configs {
                let Some(candidate) = self.platform_path(entry) else {
                    continue;
                };
                let candidate = self.expand(candidate);
                let base = if pattern.starts_with(&candidate) {
                    Some(candidate.as_path())
                } else {
                    candidate.parent().filter(|parent| {
                        candidate.extension().is_some() && pattern.starts_with(parent)
                    })
                };
                if let (Some(base), Some(keys)) = (base, entry["envOverride"].as_array()) {
                    for key in keys.iter().filter_map(Value::as_str) {
                        if let Some(value) = self.vars.get(key).filter(|v| !v.is_empty())
                            && let Ok(suffix) = pattern.strip_prefix(base)
                        {
                            return Some(Path::new(value).join(suffix));
                        }
                    }
                }
            }
        }
        Some(pattern)
    }
}
pub async fn regular_file(path: &Path, max: u64) -> Result<Option<Vec<u8>>, String> {
    let stat = match fs::symlink_metadata(path).await {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("声明来源暂不可读".into()),
    };
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > max {
        return Ok(None);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path).await.map_err(|_| "声明来源暂不可读")?;
    let mut bytes = vec![];
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "声明来源读取失败")?;
    if bytes.len() as u64 > max {
        return Err("声明来源超过读取上限".into());
    }
    Ok(Some(bytes))
}
pub async fn files(pattern: &Path, limit: usize, can_read: impl Fn() -> bool) -> Vec<PathBuf> {
    let text = pattern.to_string_lossy();
    let marker = text.find("**");
    let base = marker
        .map(|p| PathBuf::from(text[..p].trim_end_matches(['\\', '/'])))
        .or_else(|| pattern.parent().map(Path::to_path_buf));
    let Some(base) = base.filter(|p| p.is_absolute()) else {
        return vec![];
    };
    let Some(name) = pattern
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| glob::Pattern::new(s).ok())
    else {
        return vec![];
    };
    let depth = if marker.is_some() { 6 } else { 0 };
    let mut stack = vec![(base, 0)];
    let mut found = vec![];
    let mut visited = 0;
    while let Some((dir, level)) = stack.pop() {
        if !can_read() || visited >= 20000 {
            break;
        }
        let stat = match fs::symlink_metadata(&dir).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !stat.is_dir() || stat.file_type().is_symlink() {
            continue;
        }
        let mut entries = match fs::read_dir(dir).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            visited += 1;
            if visited > 20000 || !can_read() {
                break;
            }
            let kind = match entry.file_type().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() && level < depth {
                stack.push((entry.path(), level + 1));
            } else if kind.is_file()
                && entry.file_name().to_str().is_some_and(|s| name.matches(s))
                && let Ok(metadata) = entry.metadata().await
            {
                found.push((
                    entry.path(),
                    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                ));
            }
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    found.truncate(limit);
    found.into_iter().map(|v| v.0).collect()
}
pub fn process_match(output: &str, names: &[Value], windows: bool) -> Option<String> {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let command = if windows {
            line.split(',').next().unwrap_or_default().trim_matches('"')
        } else {
            line.find(char::is_whitespace)
                .filter(|pos| line[..*pos].chars().all(|c| c.is_ascii_digit()))
                .map(|pos| line[pos..].trim())
                .unwrap_or(line)
        };
        let base = command
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or_default()
            .to_lowercase();
        if names
            .iter()
            .filter_map(Value::as_str)
            .any(|n| base == n.to_lowercase() || base == format!("{}.exe", n.to_lowercase()))
        {
            return Some(command.into());
        }
    }
    None
}
pub async fn process_snapshot() -> Result<String, String> {
    let mut command = if cfg!(windows) {
        let mut c = Command::new("tasklist");
        c.args(["/FO", "CSV", "/NH"]);
        c
    } else {
        let mut c = Command::new("/bin/ps");
        c.args(["-ax", "-o", "pid=,comm="]);
        c
    };
    let mut child = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "进程探测不可用")?;
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = vec![];
        child
            .stdout
            .take()
            .ok_or("进程探测管道不可用")?
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "进程探测失败")?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("进程探测输出超过上限");
        }
        if !child.wait().await.map_err(|_| "进程探测失败")?.success() {
            return Err("进程探测失败");
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await;
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => {
            let _ = child.kill().await;
            Err("进程探测超时".into())
        }
    }
}
pub async fn probe(
    manifest: &Value,
    env: &Environment,
    processes: Option<&str>,
) -> Result<Value, String> {
    let id = manifest["id"].as_str().ok_or("适配器标识无效")?;
    let mut config = None;
    let mut version = None;
    if let Some(extensions) = manifest["detect"]["extensions"].as_array() {
        'extensions: for extension in extensions {
            let Some(extension_id) = extension["id"].as_str() else {
                continue;
            };
            if let Some(roots) = extension["roots"].as_array() {
                for entry in roots {
                    let Some(raw) = env.platform_path(entry) else {
                        continue;
                    };
                    let root = env.expand(raw);
                    let mut entries = match fs::read_dir(&root).await {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let mut candidates = vec![];
                    let mut visited = 0;
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        visited += 1;
                        if visited > 20000 {
                            break;
                        }
                        if entry
                            .file_type()
                            .await
                            .is_ok_and(|v| v.is_dir() && !v.is_symlink())
                            && entry.file_name().to_str().is_some_and(|n| {
                                n.to_lowercase()
                                    .starts_with(&format!("{}-", extension_id.to_lowercase()))
                            })
                        {
                            candidates.push(entry.path());
                        }
                    }
                    // Numeric components compare as numbers, so 4.10 sorts above 4.9.
                    candidates.sort_by_cached_key(|a| std::cmp::Reverse(version_key(a)));
                    for candidate in candidates {
                        let path = candidate.join("package.json");
                        let Some(bytes) = regular_file(&path, 1024 * 1024).await? else {
                            continue;
                        };
                        let Ok(info) = serde_json::from_slice::<Value>(&bytes) else {
                            continue;
                        };
                        if format!(
                            "{}.{}",
                            info["publisher"].as_str().unwrap_or_default(),
                            info["name"].as_str().unwrap_or_default()
                        )
                        .eq_ignore_ascii_case(extension_id)
                        {
                            config = Some(path);
                            version = info["version"].as_str().map(str::to_owned);
                            break 'extensions;
                        }
                    }
                }
            }
        }
    }
    if config.is_none()
        && let Some(entries) = manifest["detect"]["configPaths"].as_array()
    {
        'paths: for entry in entries {
            let mut candidates = vec![];
            if let Some(overrides) = entry["envOverride"].as_array() {
                for key in overrides.iter().filter_map(Value::as_str) {
                    if let Some(value) = env.vars.get(key)
                        && !value.is_empty()
                    {
                        candidates.push(PathBuf::from(value));
                    }
                }
            }
            if let Some(raw) = env.platform_path(entry) {
                candidates.push(env.expand(raw));
            }
            for path in candidates {
                if fs::metadata(&path).await.is_ok() {
                    config = Some(path);
                    break 'paths;
                }
            }
        }
    }
    let names = manifest["detect"]["processNames"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let executable = processes.and_then(|p| process_match(p, names, env.platform == "windows"));
    let mut running = executable.is_some();
    if env.probe_system
        && let Some(apis) = manifest["detect"]["apis"].as_array()
    {
        for api in apis {
            let host = api["host"].as_str().unwrap_or_default();
            if !["127.0.0.1", "localhost", "::1"].contains(&host) {
                continue;
            }
            let host = if host == "::1" { "[::1]" } else { host };
            let url = format!(
                "http://{host}:{}{}",
                api["port"].as_u64().unwrap_or(0),
                api["probePath"].as_str().unwrap_or("/")
            );
            if reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
                .map_err(|_| "本机 API 探测不可用")?
                .get(url)
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                running = true;
                break;
            }
        }
    }
    Ok(
        serde_json::json!({"toolId":id,"status":if running{"running"}else if config.is_some(){"installed"}else{"not_installed"},"configPath":config,"version":version,"executablePath":executable,"degradedReason":if env.probe_system&&processes.is_none()&&!names.is_empty(){Some("进程探测不可用；仅显示安装识别结果")}else{None}}),
    )
}
fn version_key(path: &Path) -> Vec<(bool, u64, String)> {
    let value = path.file_name().unwrap_or_default().to_string_lossy();
    let mut result = vec![];
    let mut current = String::new();
    let mut numeric = None;
    for c in value.chars() {
        let digit = c.is_ascii_digit();
        if numeric.is_some_and(|v| v != digit) {
            result.push((
                numeric.unwrap(),
                current.parse().unwrap_or(0),
                std::mem::take(&mut current),
            ));
        }
        numeric = Some(digit);
        current.push(c);
    }
    result.push((
        numeric.unwrap_or(false),
        current.parse().unwrap_or(0),
        current,
    ));
    result
}
