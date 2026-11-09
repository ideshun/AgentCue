use agentcue_runtime::discovery::{self, Environment};
use serde_json::json;
use std::{collections::HashMap, fs, path::PathBuf};
fn env(home: PathBuf) -> Environment {
    Environment {
        platform: "macos".into(),
        home,
        vars: HashMap::new(),
        probe_system: false,
    }
}
#[tokio::test]
async fn extension_detection_checks_publisher_and_numeric_versions() {
    let home = std::env::temp_dir().join(format!("agentcue-discovery-{}", uuid::Uuid::new_v4()));
    let root = home.join(".cursor/extensions");
    for (version, publisher) in [
        ("4.9.0", "saoudrizwan"),
        ("4.10.0", "saoudrizwan"),
        ("5.0.0", "wrong-publisher"),
    ] {
        let directory = root.join(format!("saoudrizwan.claude-dev-{version}"));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("package.json"),
            json!({"publisher":publisher,"name":"claude-dev","version":version}).to_string(),
        )
        .unwrap();
    }
    let manifest = agentcue_runtime::state::manifests()
        .into_iter()
        .find(|m| m["id"] == "cline")
        .unwrap();
    let result = discovery::probe(&manifest, &env(home.clone()), Some(""))
        .await
        .unwrap();
    assert_eq!(result["status"], "installed");
    assert_eq!(result["version"], "4.10.0");
    fs::remove_dir_all(home).unwrap();
}
#[tokio::test]
async fn declared_discovery_is_bounded_and_never_follows_directory_links() {
    let home = std::env::temp_dir().join(format!("agentcue-discovery-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(home.join("sources/deep")).unwrap();
    fs::create_dir_all(home.join("outside")).unwrap();
    fs::write(home.join("sources/a.jsonl"), "").unwrap();
    fs::write(home.join("sources/deep/b.jsonl"), "").unwrap();
    fs::write(home.join("outside/private.jsonl"), "").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(home.join("outside"), home.join("sources/link")).unwrap();
    let files = discovery::files(&home.join("sources/**/*.jsonl"), 500, || true).await;
    assert_eq!(files.len(), 2);
    assert!(
        files
            .iter()
            .all(|p| !p.to_string_lossy().contains("private"))
    );
    assert_eq!(
        discovery::files(&home.join("sources/*.jsonl"), 500, || true)
            .await
            .len(),
        1
    );
    assert!(
        discovery::files(&home.join("sources/**/*.jsonl"), 500, || false)
            .await
            .is_empty()
    );
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn only_declared_environment_overrides_can_change_a_source_root() {
    let mut environment = env(PathBuf::from("/synthetic/home"));
    environment
        .vars
        .insert("CODEX_HOME".into(), "/synthetic/override".into());
    environment
        .vars
        .insert("UNRELATED".into(), "/private".into());
    let manifest = agentcue_runtime::state::manifests()
        .into_iter()
        .find(|m| m["id"] == "codex")
        .unwrap();
    assert_eq!(
        environment.source_pattern(&manifest).unwrap(),
        PathBuf::from("/synthetic/override/sessions/**/*.jsonl")
    );
    let names = vec![json!("Cursor")];
    assert!(
        discovery::process_match(
            "123 /Applications/Other.app/Contents/MacOS/Other",
            &names,
            false
        )
        .is_none()
    );
    assert!(
        discovery::process_match(
            "123 /Applications/Folder With Spaces/Cursor.app/Contents/MacOS/Cursor",
            &names,
            false
        )
        .is_some()
    );
    assert!(discovery::process_match("\"Cursor.exe\",\"123\",\"Console\"", &names, true).is_some());
}
