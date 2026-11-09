//! Incremental capture of one explicitly declared source file. Scheduling/discovery live in monitor.
use crate::state::Runtime;
use agentcue_adapters::{
    digest,
    extract::{self, Context, SourceContext},
    text,
};
use agentcue_store::engine::{Checkpoint, ingest_source_batch};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io,
    path::Path,
    sync::{Arc, atomic::Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    fs::{File, OpenOptions},
    io::{AsyncReadExt, AsyncSeekExt},
};
const BUDGET: usize = 4 * 1024 * 1024;
const MAX_RECORD: usize = 32 * 1024 * 1024;
const HEAD_BUDGET: usize = 512 * 1024;
pub fn checkpoint(db: &Connection, path: &str) -> Result<Option<Checkpoint>, String> {
    db.query_row("SELECT tool_id,file_identity,byte_offset,prefix_hash,title,updated_at,context FROM source_checkpoints WHERE source_path=?",[path],|r|{
        let context:Option<String>=r.get(6)?;
        Ok(Checkpoint{source_path:path.into(),tool_id:r.get(0)?,file_identity:r.get(1)?,byte_offset:r.get(2)?,prefix_hash:r.get(3)?,title:r.get(4)?,updated_at:r.get(5)?,context:context.and_then(|s|serde_json::from_str(&s).ok())})
    }).optional().map_err(|_|"来源检查点读取失败".into())
}
fn identity(metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let created = metadata
            .created()
            .ok()
            .and_then(|s| s.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{}:{}:{created}", metadata.dev(), metadata.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        format!("windows:{}", metadata.creation_time())
    }
    #[cfg(not(any(unix, windows)))]
    {
        format!("created:{:?}", metadata.created().ok())
    }
}
fn same_identity(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    // Node's legacy birthtimeMs may contain a fractional millisecond; don't reset a valid offset for rounding.
    let a: Vec<_> = a.split(':').collect();
    let b: Vec<_> = b.split(':').collect();
    a.len() == 3
        && b.len() == 3
        && a[..2] == b[..2]
        && a[2]
            .parse::<f64>()
            .ok()
            .zip(b[2].parse::<f64>().ok())
            .is_some_and(|(x, y)| (x - y).abs() < 1.0)
}
async fn read_at(file: &mut File, offset: u64, length: usize) -> io::Result<Vec<u8>> {
    file.seek(io::SeekFrom::Start(offset)).await?;
    let mut bytes = vec![0; length];
    let mut read = 0;
    while read < length {
        let n = file.read(&mut bytes[read..]).await?;
        if n == 0 {
            break;
        }
        read += n;
    }
    bytes.truncate(read);
    Ok(bytes)
}
async fn fingerprint(file: &mut File, end: u64) -> io::Result<String> {
    let n = 256.min(end as usize);
    let head = read_at(file, 0, n).await?;
    let tail = read_at(file, end - n as u64, n).await?;
    let mut digest = Sha256::new();
    digest.update(head);
    digest.update(tail);
    Ok(format!("{:x}", digest.finalize()))
}
async fn records(
    file: &mut File,
    offset: u64,
    end: u64,
    can_read: impl Fn() -> bool,
) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = vec![];
    let mut position = offset;
    while position < end && bytes.len() < MAX_RECORD {
        if !can_read() {
            return Ok(None);
        }
        let chunk = read_at(
            file,
            position,
            BUDGET
                .min((end - position) as usize)
                .min(MAX_RECORD - bytes.len()),
        )
        .await
        .map_err(|_| "来源文件读取失败")?;
        if !can_read() || chunk.is_empty() {
            return Ok(None);
        }
        let newline = chunk.iter().rposition(|b| *b == b'\n');
        if let Some(end) = newline {
            bytes.extend_from_slice(&chunk[..=end]);
            return Ok(Some(bytes));
        }
        position += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
    }
    if position < end {
        return Err("单条会话记录超过 32MB 读取上限".into());
    }
    Ok(None)
}
fn parse(bytes: &[u8]) -> (Vec<Value>, usize) {
    let mut rows = vec![];
    let mut bad = 0;
    for line in bytes.split(|b| *b == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<Value>(line) {
            Ok(v) if v.is_object() => rows.push(v),
            _ => bad += 1,
        }
    }
    (rows, bad)
}
pub struct CaptureResult {
    pub ingested: usize,
    pub bad_lines: usize,
    pub changed: bool,
}
/// Only call with a path produced by manifest discovery or an isolated fixture; no recursive reads occur here.
pub async fn file(
    runtime: Arc<Runtime>,
    manifest: &Value,
    path: &Path,
    baseline: DateTime<Utc>,
) -> Result<CaptureResult, String> {
    let generation = runtime.generation.load(Ordering::Acquire);
    let tool = manifest["id"].as_str().ok_or("适配器标识无效")?;
    let allowed =
        || generation == runtime.generation.load(Ordering::Acquire) && runtime.enabled(tool);
    let empty = || CaptureResult {
        ingested: 0,
        bad_lines: 0,
        changed: false,
    };
    if !allowed()
        || manifest["sessionCapability"] == "detect-only"
        || manifest["eventMapping"]
            .as_object()
            .is_none_or(|o| o.is_empty())
    {
        return Ok(empty());
    }
    let symlink = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| "来源文件不可用")?;
    if !symlink.is_file() || symlink.file_type().is_symlink() {
        return Ok(empty());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut handle = options.open(path).await.map_err(|_| "来源文件无法打开")?;
    let stat = handle.metadata().await.map_err(|_| "来源文件信息不可用")?;
    let path = path.to_str().ok_or("来源路径编码不受支持")?;
    let previous = {
        let db = runtime.db.lock().map_err(|_| "database lock unavailable")?;
        checkpoint(&db, path)?
    };
    let identity = identity(&stat);
    let mut offset = previous
        .as_ref()
        .map(|p| p.byte_offset.max(0) as u64)
        .unwrap_or(0);
    let mtime: DateTime<Utc> = DateTime::from(stat.modified().unwrap_or(SystemTime::UNIX_EPOCH));
    let unchanged = if let Some(cp) = &previous {
        same_identity(&cp.file_identity, &identity)
            && stat.len() >= offset
            && fingerprint(&mut handle, offset)
                .await
                .map_err(|_| "来源边界读取失败")?
                == cp.prefix_hash
    } else {
        false
    };
    if !allowed() {
        return Ok(empty());
    }
    let reset = !unchanged
        || (previous.as_ref().is_some_and(|cp| {
            stat.len() == offset
                && DateTime::parse_from_rfc3339(&cp.updated_at)
                    .ok()
                    .is_none_or(|t| t.timestamp_millis() != mtime.timestamp_millis())
        }));
    if reset {
        offset = 0;
    } else if stat.len() == offset && previous.as_ref().is_some_and(|p| p.context.is_some()) {
        return Ok(empty());
    }
    let source = Path::new(path);
    let project = source
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
        .ok_or("来源项目目录无效")?;
    let key = source
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("来源会话标识无效")?;
    let base = format!("{tool}:{project}:{key}");
    let head = read_at(&mut handle, 0, HEAD_BUDGET.min(stat.len() as usize))
        .await
        .map_err(|_| "来源文件头读取失败")?;
    if !allowed() {
        return Ok(empty());
    }
    let end = head
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let (head_rows, _) = parse(&head[..end]);
    let header = extract::extract(
        &head_rows,
        manifest,
        Context {
            tool_id: tool,
            project,
            session_key: key,
            source_path: Some(path),
            title: None,
            context: Default::default(),
        },
    );
    let mut context = if !reset && offset <= end as u64 {
        let (rows, _) = parse(&head[..offset as usize]);
        extract::extract(
            &rows,
            manifest,
            Context {
                tool_id: tool,
                project,
                session_key: key,
                source_path: Some(path),
                title: None,
                context: Default::default(),
            },
        )
        .context
    } else if !reset {
        previous
            .as_ref()
            .and_then(|p| p.context.as_ref())
            .and_then(|c| serde_json::from_value::<SourceContext>(c.clone()).ok())
            .unwrap_or_default()
    } else {
        SourceContext::default()
    };
    if header.context.excluded.is_some() {
        context.excluded = header.context.excluded;
    }
    let mut title = if context.excluded == Some(true) {
        None
    } else {
        head_rows
            .iter()
            .find_map(text::user_titles)
            .map(|p| p.0)
            .or_else(|| previous.as_ref().and_then(|p| p.title.clone()))
    };
    let consumed = if stat.len() > offset {
        records(&mut handle, offset, stat.len(), &allowed).await?
    } else {
        None
    };
    if !allowed() {
        return Ok(empty());
    }
    let (rows, bad_lines) = consumed
        .as_ref()
        .map(|bytes| parse(bytes))
        .unwrap_or_default();
    if title.is_none() && context.excluded != Some(true) {
        title = rows.iter().find_map(text::user_titles).map(|p| p.0);
    }
    let extracted = extract::extract(
        &rows,
        manifest,
        Context {
            tool_id: tool,
            project,
            session_key: key,
            source_path: Some(path),
            title: title.as_deref(),
            context,
        },
    );
    let excluded = extracted.context.excluded == Some(true);
    if excluded {
        title = None;
    }
    let mut events = extracted.events;
    let mut silent = HashSet::new();
    let batch = {
        let db = runtime.db.lock().map_err(|_| "database lock unavailable")?;
        if previous.is_none() {
            events.retain(|e| {
                let time = DateTime::parse_from_rfc3339(&e.occurred_at).ok();
                let newer = db
                    .query_row(
                        "SELECT updated_at FROM sessions WHERE session_id=?",
                        [&e.session_id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                    .is_none_or(|s| DateTime::parse_from_rfc3339(&s).ok() < time);
                time.is_some_and(|t| {
                    Utc::now().signed_duration_since(t).num_milliseconds() <= 6 * 60 * 60 * 1000
                }) && newer
            });
        }
        events.sort_by_key(|e| DateTime::parse_from_rfc3339(&e.occurred_at).ok());
        let mut seen = HashSet::new();
        let mut batch = vec![];
        for event in events {
            if seen.insert(event.session_id.clone()) {
                let exists = db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=?)",
                        [&event.session_id],
                        |r| r.get::<_, bool>(0),
                    )
                    .map_err(|_| "会话查询失败")?;
                if !exists && event.event_type != "task.started" {
                    let mut bootstrap = event.clone();
                    bootstrap.event_id = format!(
                        "evt_{}",
                        digest(&format!("{path}:{}:bootstrap", event.session_id))
                    );
                    bootstrap.event_type = "task.started".into();
                    bootstrap
                        .payload
                        .insert("reason".into(), json!("扫描补全起始事件"));
                    silent.insert(bootstrap.event_id.clone());
                    batch.push(bootstrap);
                }
            }
            batch.push(event);
        }
        batch
    };
    let next_offset = offset + consumed.as_ref().map(Vec::len).unwrap_or(0) as u64;
    let prefix_hash = fingerprint(&mut handle, next_offset)
        .await
        .map_err(|_| "来源边界读取失败")?;
    if !allowed() {
        return Ok(empty());
    }
    let after = handle.metadata().await.map_err(|_| "来源文件信息不可用")?;
    if after.len() != stat.len() || after.modified().ok() != stat.modified().ok() {
        return Ok(empty());
    }
    let cp = Checkpoint {
        source_path: path.into(),
        tool_id: tool.into(),
        file_identity: identity,
        byte_offset: next_offset as i64,
        prefix_hash,
        title: title.clone(),
        updated_at: mtime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        context: Some(serde_json::to_value(&extracted.context).map_err(|_| "来源上下文无效")?),
    };
    let mut titles = vec![];
    if !excluded {
        titles.push((base.clone(), title));
        titles.extend(
            header
                .titles
                .into_iter()
                .chain(extracted.titles)
                .filter(|t| t.title.is_some())
                .map(|t| (t.session_id, t.title)),
        );
    }
    let transitions = {
        let settings = runtime
            .settings
            .lock()
            .map_err(|_| "settings lock unavailable")?;
        if generation != runtime.generation.load(Ordering::Acquire)
            || settings["privacy"]["sessionFileRead"] != true
            || settings["scan"]["ignoredToolIds"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == tool))
        {
            return Ok(empty());
        }
        let mut db = runtime.db.lock().map_err(|_| "database lock unavailable")?;
        ingest_source_batch(
            &mut db,
            &batch,
            &cp,
            previous.as_ref(),
            &titles,
            Some((&base, !excluded)),
            settings["privacy"]["auditLog"] == true,
        )
        .map_err(|e| e.to_string())?
    };
    let ingested = transitions
        .iter()
        .filter(|t| !silent.contains(&t.event_id))
        .count();
    for result in &transitions {
        let event = batch
            .iter()
            .find(|e| e.event_id == result.event_id)
            .unwrap();
        runtime.emit("state.transition",json!({"sessionId":result.session_id,"prevState":result.previous.as_str(),"nextState":result.next.as_str(),"eventType":event.event_type,"ts":event.occurred_at}));
        if !silent.contains(&event.event_id)
            && DateTime::parse_from_rfc3339(&event.occurred_at).is_ok_and(|t| t >= baseline)
        {
            runtime
                .notices
                .send(event.clone())
                .await
                .map_err(|_| "提醒服务已经退出")?;
        }
    }
    let changed = consumed.is_some() || !titles.is_empty() || excluded;
    if changed {
        runtime.emit("board.updated", json!({}));
    }
    Ok(CaptureResult {
        ingested,
        bad_lines,
        changed,
    })
}
