use agentcue_runtime::settings::{defaults, merge, validate, write_atomic};
use serde_json::json;
#[test]
fn invalid_ranges_numbers_and_unknown_fields_are_rejected() {
    for patch in [
        json!({"voice":{"volume":1.1}}),
        json!({"quiet":{"ranges":[{"from":"25:00","to":"08:00"}]}}),
        json!({"voice":{"backend":"unknown"}}),
        json!({"voice":{"unexpected":true}}),
    ] {
        assert!(merge(&defaults(), &patch).is_err());
    }
    assert!(validate(&defaults()).is_ok());
}
#[test]
fn edits_preserve_other_settings_and_saved_secret() {
    let mut base = defaults();
    base["voice"]["cloudApiKey"] = json!("synthetic-secret");
    base["quiet"]["ranges"] = json!([{"from":"20:00","to":"21:00"},{"from":"23:00","to":"07:00"}]);
    let value = merge(&base, &json!({"voice":{"volume":0.35}})).unwrap();
    assert_eq!(value["voice"]["volume"], 0.35);
    assert_eq!(value["voice"]["cloudApiKey"], "synthetic-secret");
    assert_eq!(value["quiet"], base["quiet"]);
    assert_eq!(
        merge(&value, &json!({"voice":{"cloudApiKey":""}})).unwrap()["voice"]["cloudApiKey"],
        ""
    );
}
#[test]
fn atomic_settings_are_complete_and_private() {
    let dir = std::env::temp_dir().join(format!("agentcue-settings-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("settings.json");
    write_atomic(&path, &defaults()).unwrap();
    let next = merge(&defaults(), &json!({"voice":{"volume":0.0}})).unwrap();
    write_atomic(&path, &next).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap(),
        next
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}
