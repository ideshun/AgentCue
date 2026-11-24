//! Explicit local maintenance. Reports omit task content; backups remain private on this machine.
use crate::{
    control::{ControlError, Result},
    queries, settings,
    state::Runtime,
};
use rusqlite::{Connection, MAIN_DB, OpenFlags, params};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn invalid(message: &str) -> ControlError {
    ControlError::invalid(message)
}
fn directory(path: &Path) -> Result<()> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(invalid("数据目录不能是符号链接"));
    }
    fs::create_dir_all(path).map_err(|_| ControlError::unavailable())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| ControlError::unavailable())?;
    }
    Ok(())
}
fn regular(path: &Path) -> Result<()> {
    if !path
        .symlink_metadata()
        .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
    {
        return Err(invalid("备份文件不存在或不是普通文件"));
    }
    Ok(())
}
fn read_json(path: &Path) -> Result<Value> {
    regular(path)?;
    if fs::metadata(path)
        .map_err(|_| ControlError::unavailable())?
        .len()
        > 1024 * 1024
    {
        return Err(invalid("配置文件过大"));
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| ControlError::unavailable())?)
        .map_err(|_| invalid("配置文件损坏"))
}
fn backup_path(root: &Path, id: &str) -> Result<PathBuf> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(invalid("备份编号无效"));
    }
    if root
        .join("backups")
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(invalid("备份根目录无效"));
    }
    let path = root.join("backups").join(id);
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(invalid("备份目录无效"));
    }
    Ok(path)
}
fn private_snapshot(db: &Connection, path: &Path) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| ControlError::unavailable())?;
    db.backup(MAIN_DB, path, None)
        .map_err(|_| ControlError::unavailable())
}
fn bytes(path: &Path) -> u64 {
    let Ok(meta) = path.symlink_metadata() else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len();
    }
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| bytes(&e.path()))
        .sum()
}
pub fn preferences(root: &Path) -> Value {
    fs::read(root.join("maintenance.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(|v| {
            v["retentionDays"]
                .as_u64()
                .is_some_and(|d| d == 0 || (7..=3650).contains(&d))
        })
        .unwrap_or_else(|| json!({"retentionDays":0}))
}
pub fn set_preferences(root: &Path, value: &Value) -> Result<Value> {
    let days = value["retentionDays"]
        .as_u64()
        .filter(|d| *d == 0 || (7..=3650).contains(d))
        .ok_or_else(|| invalid("保留天数须为 0（永久）或 7–3650 的整数"))?;
    let value = json!({"retentionDays":days});
    settings::write_atomic(&root.join("maintenance.json"), &value)
        .map_err(|_| ControlError::unavailable())?;
    Ok(value)
}
pub fn info(runtime: &Runtime) -> Result<Value> {
    let root = &runtime.data_dir;
    let mut backups = vec![];
    if let Ok(entries) = fs::read_dir(root.join("backups")) {
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            if let Ok(path) = backup_path(root, &id)
                && let Ok(v) = read_json(&path.join("manifest.json"))
                && v["formatVersion"] == 1
                && v["createdAt"].as_str().is_some()
            {
                backups.push(json!({"id":id,"createdAt":v["createdAt"],"version":v["version"],"bytes":bytes(&path)}));
            }
        }
    }
    backups.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
    let sessions = {
        let db = runtime.db.lock().map_err(|_| ControlError::unavailable())?;
        queries::count(&db, &[], None, None)?
    };
    let backup_bytes: u64 = backups.iter().filter_map(|b| b["bytes"].as_u64()).sum();
    Ok(
        json!({"dataDir":root,"configDir":runtime.config_dir,"databaseBytes":bytes(&root.join("awm.db"))+bytes(&root.join("awm.db-wal")),"modelBytes":bytes(&root.join("models")),"backupBytes":backup_bytes,"backups":backups,"preferences":preferences(root),"restorePending":root.join("restore-request.json").is_file(),"restoreResult":read_json(&root.join("restore-result.json")).ok(),"sessions":sessions}),
    )
}
pub fn backup(runtime: &Runtime) -> Result<Value> {
    let config = runtime.config();
    create_backup_with(&runtime.data_dir, &config, |path| {
        let db = runtime.db.lock().map_err(|_| ControlError::unavailable())?;
        private_snapshot(&db, path)
    })
}
fn create_backup(db: &Connection, root: &Path, config: &Value) -> Result<Value> {
    create_backup_with(root, config, |path| private_snapshot(db, path))
}
fn create_backup_with(
    root: &Path,
    config: &Value,
    snapshot: impl FnOnce(&Path) -> Result<()>,
) -> Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    directory(&root.join("backups"))?;
    let path = backup_path(root, &id)?;
    directory(&path)?;
    let result = (|| {
        snapshot(&path.join("awm.db"))?;
        let mut config = config.clone();
        config["voice"]["cloudApiKey"] = json!("");
        settings::write_atomic(&path.join("settings.json"), &config)
            .map_err(|_| ControlError::unavailable())?;
        let manifest = json!({"formatVersion":1,"createdAt":queries::now(),"version":env!("CARGO_PKG_VERSION"),"modelsIncluded":false,"cloudApiKeyIncluded":false});
        settings::write_atomic(&path.join("manifest.json"), &manifest)
            .map_err(|_| ControlError::unavailable())?;
        Ok(json!({"id":id,"createdAt":manifest["createdAt"]}))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(path);
    }
    result
}
fn validate_backup(path: &Path) -> Result<()> {
    regular(&path.join("awm.db"))?;
    regular(&path.join("settings.json"))?;
    if read_json(&path.join("manifest.json"))?["formatVersion"] != 1 {
        return Err(invalid("备份格式不兼容"));
    }
    let config = read_json(&path.join("settings.json"))?;
    settings::validate(&config).map_err(|_| invalid("备份设置不兼容"))?;
    let source = Connection::open_with_flags(path.join("awm.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| invalid("备份数据库不可读"))?;
    let version: i64 = source
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|_| invalid("备份数据库无效"))?;
    let check: String = source
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|_| invalid("备份数据库检查失败"))?;
    // Backup format 1 starts at schema 5; startup migrates older compatible snapshots.
    if !(5..=agentcue_store::SCHEMA_VERSION).contains(&version) || check != "ok" {
        return Err(invalid("备份数据库版本不兼容或文件损坏"));
    }
    source
        .prepare("SELECT session_id,tool_id,title,current_state,visible FROM sessions LIMIT 0")
        .map_err(|_| invalid("备份缺少任务数据表"))?;
    source
        .prepare("SELECT event_id,payload FROM state_events LIMIT 0")
        .map_err(|_| invalid("备份缺少事件数据表"))?;
    source
        .prepare("SELECT rule_id FROM voice_rules LIMIT 0")
        .map_err(|_| invalid("备份缺少播报规则表"))?;
    Ok(())
}
pub fn request_restore(runtime: &Runtime, id: &str) -> Result<Value> {
    validate_backup(&backup_path(&runtime.data_dir, id)?)?;
    // A new safety backup is mandatory before any restore is scheduled.
    let safety = backup(runtime)?;
    settings::write_atomic(
        &runtime.data_dir.join("restore-request.json"),
        &json!({"id":id,"safetyBackupId":safety["id"]}),
    )
    .map_err(|_| ControlError::unavailable())?;
    Ok(json!({"restartRequired":true,"safetyBackupId":safety["id"]}))
}
pub fn cancel_restore(root: &Path) -> Result<()> {
    match fs::remove_file(root.join("restore-request.json")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ControlError::unavailable()),
    }
}
/// Called under the exclusive application lock, before readers and playback are started.
pub fn apply_pending(root: &Path, config_dir: &Path) -> std::result::Result<(), String> {
    let request = root.join("restore-request.json");
    if !request.exists() {
        return Ok(());
    }
    let mut rollback_failed = false;
    let result = (|| -> Result<()> {
        let value = read_json(&request)?;
        let path = backup_path(
            root,
            value["id"]
                .as_str()
                .ok_or_else(|| invalid("恢复请求无效"))?,
        )?;
        validate_backup(&path)?;
        regular(&root.join("awm.db"))?;
        let current = settings::load(&config_dir.join("settings.json"))
            .map_err(|_| ControlError::unavailable())?;
        let mut restored =
            settings::load(&path.join("settings.json")).map_err(|_| ControlError::unavailable())?;
        for key in [
            "cloudApiKey",
            "cloudEnabled",
            "cloudEndpoint",
            "cloudProvider",
            "cloudModel",
            "cloudVoice",
            "backend",
        ] {
            restored["voice"][key] = current["voice"][key].clone();
        }
        let mut db =
            Connection::open(root.join("awm.db")).map_err(|_| ControlError::unavailable())?;
        // Snapshot again under the exclusive startup lock, including changes since scheduling.
        let safety = create_backup(&db, root, &current)?;
        let safety = backup_path(root, safety["id"].as_str().unwrap_or_default())?;
        let restored_db = db
            .restore(
                MAIN_DB,
                path.join("awm.db"),
                None::<fn(rusqlite::backup::Progress)>,
            )
            .is_ok();
        if !restored_db
            || settings::write_atomic(&config_dir.join("settings.json"), &restored).is_err()
        {
            let db_ok = db
                .restore(
                    MAIN_DB,
                    safety.join("awm.db"),
                    None::<fn(rusqlite::backup::Progress)>,
                )
                .is_ok();
            let config_ok =
                settings::write_atomic(&config_dir.join("settings.json"), &current).is_ok();
            rollback_failed = !db_ok || !config_ok;
            return Err(invalid("恢复失败，已尝试还原到启动前的安全备份"));
        }
        Ok(())
    })();
    if rollback_failed {
        return Err("备份恢复与自动回滚未能完成。请从数据目录 backups 中的最新安全备份恢复；为保护数据，应用未启动采集。".into());
    }
    let status = match result {
        Ok(()) => json!({"ok":true,"message":"备份恢复已完成"}),
        Err(error) => json!({"ok":false,"message":format!("恢复未执行或已回滚：{}",error.message)}),
    };
    settings::write_atomic(&root.join("restore-result.json"), &status)
        .map_err(|_| "无法保存恢复结果")?;
    cancel_restore(root).map_err(|_| "无法清除恢复请求")?;
    Ok(())
}
fn cutoff(days: u64) -> Result<String> {
    if !(7..=3650).contains(&days) {
        return Err(invalid("清理天数须为 7–3650"));
    }
    Ok((chrono::Utc::now() - chrono::Duration::days(days as i64)).to_rfc3339())
}
const OLD: &str =
    "current_state IN ('completed','cancelled','idle') AND julianday(updated_at)<julianday(?1)";
pub fn cleanup(runtime: &Runtime, days: u64, apply: bool) -> Result<Value> {
    let before = cutoff(days)?;
    let audit = runtime.config()["privacy"]["auditLog"] == true;
    let mut db = runtime.db.lock().map_err(|_| ControlError::unavailable())?;
    let count: i64 = db.query_row(
        &format!("SELECT count(*) FROM sessions WHERE {OLD}"),
        [&before],
        |r| r.get(0),
    )?;
    if apply {
        let tx = db.transaction()?;
        if count > 0 {
            for table in ["notifications", "state_events"] {
                tx.execute(&format!("DELETE FROM {table} WHERE session_id IN (SELECT session_id FROM sessions WHERE {OLD})"),[&before])?;
            }
            tx.execute(&format!("DELETE FROM sessions WHERE {OLD}"), [&before])?;
            if audit {
                tx.execute("INSERT INTO audit_log(ts,actor,action,result) VALUES(?1,'human','history.cleanup',?2)",params![queries::now(),format!("{count} terminal sessions")])?;
            }
        }
        tx.execute(
            "DELETE FROM audit_log WHERE julianday(ts)<julianday(?1)",
            [&before],
        )?;
        tx.commit()?;
        if count > 0 {
            runtime.emit("board.updated", json!({}));
        }
    }
    Ok(json!({"count":count,"days":days,"applied":apply}))
}
pub fn report(runtime: &Runtime) -> Result<Value> {
    let config = runtime.config();
    let db = runtime.db.lock().map_err(|_| ControlError::unavailable())?;
    // Strict allowlist: no titles, paths, error messages, commands, event bodies, or credentials.
    let tools=queries::tools(&db,&runtime.manifests,&config)?.into_iter().map(|t|json!({"toolId":t["toolId"],"detectStatus":t["detectStatus"],"sessionCapability":t["sessionCapability"],"ignored":t["ignored"],"milestones":t["milestones"]})).collect::<Vec<_>>();
    Ok(
        json!({"reportVersion":1,"version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"generatedAt":queries::now(),"uptimeSeconds":runtime.started.elapsed().as_secs(),"tools":tools,"counts":queries::counts(&db,None)?}),
    )
}

pub fn task_location(runtime: &Runtime, id: &str) -> Result<Value> {
    let config = runtime.config();
    if config["privacy"]["sessionFileRead"] != true {
        return Err(invalid("任务读取已关闭"));
    }
    let db = runtime.db.lock().map_err(|_| ControlError::unavailable())?;
    let row=queries::rows(&db,"SELECT s.tool_id AS toolId,s.project,t.executable_path AS executable FROM sessions s JOIN tools t ON t.tool_id=s.tool_id WHERE s.session_id=? AND s.visible=1",vec![rusqlite::types::Value::Text(id.into())])?.into_iter().next().ok_or_else(||ControlError::missing("任务不存在或已隐藏"))?;
    if config["scan"]["ignoredToolIds"]
        .as_array()
        .is_some_and(|v| v.iter().any(|v| v == &row["toolId"]))
    {
        return Err(invalid("工具已忽略"));
    }
    let mut row = row;
    row["bundleNames"] = json!(agentcue_adapters::launch::macos_bundles(
        row["toolId"].as_str().unwrap_or_default()
    ));
    Ok(row)
}

pub fn pronunciation(root: &Path) -> Value {
    fs::read(root.join("pronunciation.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}
pub fn save_pronunciation(root: &Path, value: &Value) -> Result<Value> {
    let entries = value
        .as_object()
        .filter(|m| m.len() <= 100)
        .ok_or_else(|| invalid("发音表最多 100 项"))?;
    for (word, reading) in entries {
        if word.trim().is_empty()
            || word.chars().count() > 80
            || word.contains(['\r', '\n'])
            || reading.as_str().is_none_or(|s| {
                s.trim().is_empty() || s.chars().count() > 160 || s.contains(['\r', '\n'])
            })
        {
            return Err(invalid("每项须为原词和读法，且不能包含换行"));
        }
    }
    settings::write_atomic(&root.join("pronunciation.json"), value)
        .map_err(|_| ControlError::unavailable())?;
    Ok(value.clone())
}
pub fn apply_pronunciation(text: &str, entries: &Value) -> String {
    let Some(entries) = entries.as_object() else {
        return text.into();
    };
    let mut keys = entries.keys().filter(|k| !k.is_empty()).collect::<Vec<_>>();
    keys.sort_by_key(|k| std::cmp::Reverse(k.len()));
    let mut out = String::new();
    let mut offset = 0;
    while offset < text.len() {
        let remaining = &text[offset..];
        let previous = text[..offset].chars().next_back();
        if let Some(key) = keys.iter().find(|key| {
            remaining.starts_with(key.as_str())
                && !(key
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
                    && previous.is_some_and(|c| c.is_ascii_alphanumeric()))
                && !(key
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
                    && remaining[key.len()..]
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphanumeric()))
        }) {
            out.push_str(entries[key.as_str()].as_str().unwrap_or(key));
            offset += key.len();
        } else {
            let ch = remaining.chars().next().unwrap();
            out.push(ch);
            offset += ch.len_utf8();
        }
    }
    out.chars().take(600).collect()
}
