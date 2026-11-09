use serde_json::Value;
#[cfg(unix)]
use std::fs::File;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

pub fn defaults() -> Value {
    serde_json::from_str(include_str!("../resources/default-settings.json"))
        .expect("embedded settings")
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "设置参数无效")
}
fn time(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        let b = s.as_bytes();
        b.len() == 5
            && b[2] == b':'
            && s[..2].parse::<u8>().is_ok_and(|n| n < 24)
            && s[3..].parse::<u8>().is_ok_and(|n| n < 60)
    })
}
pub fn validate(v: &Value) -> io::Result<()> {
    if v["schemaVersion"] != 1 {
        return Err(invalid());
    }
    for section in ["scan", "voice", "quiet", "privacy"] {
        if !v[section].is_object() {
            return Err(invalid());
        }
    }
    for (section, keys) in [
        ("voice", vec!["enabled", "cloudEnabled"]),
        ("quiet", vec!["globalMute", "waitingHumanOverride"]),
        ("privacy", vec!["sessionFileRead", "auditLog"]),
    ] {
        for key in keys {
            if !v[section][key].is_boolean() {
                return Err(invalid());
            }
        }
    }
    for (key, lo, hi) in [("volume", 0.0, 1.0), ("rate", 0.5, 2.0)] {
        if !v["voice"][key]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= lo && n <= hi)
        {
            return Err(invalid());
        }
    }
    if !v["scan"]["autoIntervalHours"]
        .as_u64()
        .is_some_and(|n| n > 0)
        || !v["voice"]["rulesRevision"].is_u64()
    {
        return Err(invalid());
    }
    for (section, key, allowed) in [
        (
            "voice",
            "backend",
            vec!["native", "local", "cloud", "piper"],
        ),
        ("voice", "localEngine", vec!["kokoro", "zipvoice"]),
        ("voice", "scope", vec!["attention", "milestones", "all"]),
        ("voice", "content", vec!["title", "prompt"]),
        ("voice", "cloudProvider", vec!["mimo"]),
        ("privacy", "scanScope", vec!["minimal", "standard", "full"]),
    ] {
        if !v[section][key]
            .as_str()
            .is_some_and(|s| allowed.contains(&s))
        {
            return Err(invalid());
        }
    }
    for (key, max) in [
        ("voiceProfile", usize::MAX),
        ("cloudApiKey", 500),
        ("cloudEndpoint", 500),
        ("cloudModel", 120),
        ("cloudVoice", 80),
        ("zipvoiceReferencePath", 500),
        ("zipvoiceReferenceText", 500),
    ] {
        if !v["voice"][key]
            .as_str()
            .is_some_and(|s| s.chars().count() <= max)
        {
            return Err(invalid());
        }
    }
    let Some(ranges) = v["quiet"]["ranges"].as_array() else {
        return Err(invalid());
    };
    for range in ranges {
        if !time(&range["from"]) || !time(&range["to"]) {
            return Err(invalid());
        }
    }
    let Some(ignored) = v["scan"]["ignoredToolIds"].as_array() else {
        return Err(invalid());
    };
    if ignored.iter().any(|x| !x.is_string()) {
        return Err(invalid());
    }
    let Some(tools) = v["scan"]["customTools"].as_array() else {
        return Err(invalid());
    };
    for tool in tools {
        if !tool["id"].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        }) || !tool["name"].as_str().is_some_and(|s| !s.is_empty())
            || !tool["configPath"].as_str().is_some_and(|s| !s.is_empty())
        {
            return Err(invalid());
        }
    }
    let Some(voices) = v["voice"]["savedVoices"].as_array() else {
        return Err(invalid());
    };
    let mut seen = HashSet::new();
    if voices.len() > 100 {
        return Err(invalid());
    }
    for voice in voices {
        let Some(profile) = voice["profile"].as_str() else {
            return Err(invalid());
        };
        if profile.is_empty()
            || profile.chars().count() > 80
            || !seen.insert(profile)
            || !voice["name"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.trim().chars().count() <= 32)
        {
            return Err(invalid());
        }
    }
    Ok(())
}

pub fn merge(base: &Value, patch: &Value) -> io::Result<Value> {
    let mut next = base.clone();
    let obj = patch.as_object().ok_or_else(invalid)?;
    for (section, value) in obj {
        if !["scan", "voice", "quiet", "privacy", "schemaVersion"].contains(&section.as_str()) {
            return Err(invalid());
        }
        if section == "schemaVersion" {
            if value != 1 {
                return Err(invalid());
            }
            continue;
        }
        let fields = value.as_object().ok_or_else(invalid)?;
        for (key, value) in fields {
            if next[section].get(key).is_none() {
                return Err(invalid());
            }
            next[section][key] = value.clone();
        }
    }
    normalize_endpoint(&mut next)?;
    validate(&next)?;
    Ok(next)
}

pub fn write_atomic(path: &Path, value: &Value) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let tmp = PathBuf::from(tmp);
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Fill fields introduced after older releases while preserving explicit user settings.
pub fn load(path: &Path) -> io::Result<Value> {
    if !path.exists() {
        return Ok(defaults());
    }
    let raw: Value = serde_json::from_slice(&fs::read(path)?)?;
    if raw.get("schemaVersion") != Some(&Value::from(1)) {
        return Err(invalid());
    }
    let mut value = defaults();
    for section in ["scan", "voice", "quiet", "privacy"] {
        if let Some(fields) = raw.get(section).and_then(Value::as_object) {
            for (key, field) in fields {
                if value[section].get(key).is_some() {
                    value[section][key] = field.clone()
                }
            }
        } else if raw.get(section).is_some() {
            return Err(invalid());
        }
    }
    normalize_endpoint(&mut value)?;
    validate(&value)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(value)
}

pub fn normalize_endpoint(settings: &mut Value) -> io::Result<()> {
    let raw = settings["voice"]["cloudEndpoint"]
        .as_str()
        .ok_or_else(invalid)?
        .trim();
    let base = if raw.is_empty() {
        "https://api.xiaomimimo.com/v1/chat/completions"
    } else {
        raw
    };
    let normalized = match reqwest::Url::parse(base) {
        Ok(mut url) => {
            let path = url.path().trim_end_matches('/');
            if ["", "/v1", "/anthropic"].contains(&path) {
                url.set_path("/v1/chat/completions");
                url.to_string()
            } else {
                base.to_owned()
            }
        }
        Err(_) => base.to_owned(),
    };
    settings["voice"]["cloudEndpoint"] = Value::String(normalized);
    Ok(())
}
