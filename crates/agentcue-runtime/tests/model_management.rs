use agentcue_runtime::voice::models::{Models, Spec};
use serde_json::json;
use std::sync::Weak;
#[tokio::test]
async fn imported_models_have_a_hash_baseline_and_tampering_is_detected() {
    let root = std::env::temp_dir().join(format!(
        "agentcue-model-management-{}",
        uuid::Uuid::new_v4()
    ));
    let source = root.join("source");
    std::fs::create_dir_all(source.join("dictionary")).unwrap();
    std::fs::write(source.join("model.onnx"), b"synthetic-model-data").unwrap();
    std::fs::write(source.join("dictionary/words"), b"synthetic-dictionary").unwrap();
    let spec:Spec=serde_json::from_value(json!({"kind":"kokoro","dirName":"fixture-model","archiveUrl":"https://example.com/not-downloaded","requiredFiles":[{"name":"model.onnx","minBytes":10}],"requiredDirs":["dictionary"]})).unwrap();
    let models = Models::new(root.join("models"), Weak::new(), vec![spec]);
    models.import("kokoro", source.clone()).await.unwrap();
    assert_eq!(models.status("kokoro")["state"], "ready");
    assert_eq!(models.verify("kokoro").unwrap()["baselineCreated"], false);
    let dir = models.directory("kokoro").unwrap();
    std::fs::write(dir.join("dictionary/words"), b"tampered-dictionary").unwrap();
    assert!(models.verify("kokoro").is_err());
    std::fs::write(dir.join(".agentcue-integrity.json"), b"invalid-json").unwrap();
    assert!(models.verify("kokoro").is_err());
    models.import("kokoro", source).await.unwrap();
    std::fs::write(root.join("models/fixture-model.tar.bz2.part"), b"partial").unwrap();
    models.remove("kokoro").await.unwrap();
    assert!(!root.join("models/fixture-model.tar.bz2.part").exists());
    assert_eq!(models.status("kokoro")["state"], "missing");
    assert!(models.remove("other").await.is_err());
    models.close().await;
    assert!(models.start("kokoro").is_err());
    assert!(models.verify("kokoro").is_err());
    drop(models);
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn model_import_rejects_symlinks_without_replacing_existing_files() {
    let root = std::env::temp_dir().join(format!("agentcue-model-links-{}", uuid::Uuid::new_v4()));
    let source = root.join("source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(root.join("outside"), b"synthetic-data").unwrap();
    std::os::unix::fs::symlink(root.join("outside"), source.join("model.onnx")).unwrap();
    let spec:Spec=serde_json::from_value(json!({"kind":"kokoro","dirName":"fixture","archiveUrl":"https://example.com/not-downloaded","requiredFiles":[{"name":"model.onnx","minBytes":1}]})).unwrap();
    let models = Models::new(root.join("models"), Weak::new(), vec![spec]);
    assert!(models.import("kokoro", source).await.is_err());
    assert!(!root.join("models/fixture").exists());
    models.close().await;
    drop(models);
    std::fs::remove_dir_all(root).unwrap();
}
