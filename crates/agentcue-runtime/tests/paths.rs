use agentcue_runtime::{
    paths::{self, AppPaths},
    state::Runtime,
};
use agentcue_store::migrate;
use rusqlite::Connection;
use serde_json::json;
use std::{fs, path::PathBuf};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("agentcue-paths-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture_paths(root: &std::path::Path) -> AppPaths {
    AppPaths {
        data_dir: root.join("new-data"),
        config_dir: root.join("new-config"),
        legacy_data_dir: Some(root.join("old/AI Workflow Monitor")),
    }
}

#[test]
fn migrates_data_and_rewrites_moved_voice_reference() {
    let fixture = Fixture::new();
    let paths = fixture_paths(&fixture.0);
    let legacy = paths.legacy_data_dir.as_ref().unwrap();
    fs::create_dir_all(legacy.join("models/kokoro")).unwrap();
    fs::create_dir_all(legacy.join("voice-references")).unwrap();
    fs::write(legacy.join("awm.db"), b"database").unwrap();
    fs::write(legacy.join("models/kokoro/model.bin"), b"model").unwrap();
    fs::write(legacy.join("voice-references/reference.wav"), b"audio").unwrap();
    let config =
        json!({"voice":{"zipvoiceReferencePath":legacy.join("voice-references/reference.wav")}});
    fs::write(
        legacy.join("settings.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();

    paths::migrate_legacy(&paths).unwrap();

    assert_eq!(
        fs::read(paths.data_dir.join("awm.db")).unwrap(),
        b"database"
    );
    assert_eq!(
        fs::read(paths.data_dir.join("models/kokoro/model.bin")).unwrap(),
        b"model"
    );
    assert_eq!(
        fs::read(paths.data_dir.join("voice-references/reference.wav")).unwrap(),
        b"audio"
    );
    let moved: serde_json::Value =
        serde_json::from_slice(&fs::read(paths.config_dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        moved["voice"]["zipvoiceReferencePath"],
        paths
            .data_dir
            .join("voice-references/reference.wav")
            .to_string_lossy()
            .as_ref()
    );
    assert!(!legacy.join("awm.db").exists());
    paths::migrate_legacy(&paths).unwrap();
}

#[test]
fn does_not_overwrite_new_data_or_migrate_while_old_instance_holds_lock() {
    let fixture = Fixture::new();
    let paths = fixture_paths(&fixture.0);
    let legacy = paths.legacy_data_dir.as_ref().unwrap();
    fs::create_dir_all(legacy).unwrap();
    fs::create_dir_all(&paths.data_dir).unwrap();
    fs::write(legacy.join("awm.db"), b"old").unwrap();
    fs::write(paths.data_dir.join("awm.db"), b"new").unwrap();

    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    let lock = options.open(legacy.join("agentcue.lock")).unwrap();
    lock.try_lock().unwrap();
    assert!(paths::migrate_legacy(&paths).is_err());
    drop(lock);

    paths::migrate_legacy(&paths).unwrap();
    assert_eq!(fs::read(paths.data_dir.join("awm.db")).unwrap(), b"new");
    assert_eq!(fs::read(legacy.join("awm.db")).unwrap(), b"old");
}

#[test]
#[cfg(unix)]
fn rejects_symlinks_without_following_them() {
    let fixture = Fixture::new();
    let paths = fixture_paths(&fixture.0);
    let legacy = paths.legacy_data_dir.as_ref().unwrap();
    fs::create_dir_all(legacy).unwrap();
    let outside = fixture.0.join("outside");
    fs::write(&outside, b"secret").unwrap();
    std::os::unix::fs::symlink(&outside, legacy.join("linked")).unwrap();

    assert!(paths::migrate_legacy(&paths).is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"secret");
}

#[test]
fn runtime_persists_settings_in_the_config_directory() {
    let fixture = Fixture::new();
    let data_dir = fixture.0.join("data");
    let config_dir = fixture.0.join("config");
    let mut db = Connection::open_in_memory().unwrap();
    migrate(&mut db).unwrap();

    let (runtime, _) =
        Runtime::new_with_config_dir(db, &data_dir, &config_dir, fixture.0.join("AgentCue"))
            .unwrap();
    runtime
        .update_settings(&json!({"voice":{"volume":0.4}}))
        .unwrap();

    assert!(config_dir.join("settings.json").is_file());
    assert!(!data_dir.join("settings.json").exists());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(config_dir.join("settings.json")).unwrap()
        )
        .unwrap()["voice"]["volume"],
        0.4
    );
}
