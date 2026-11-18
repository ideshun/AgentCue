use agentcue_runtime::icons;
use std::fs;
#[test]
fn local_icons_accept_raster_formats_and_reject_other_files_and_oversize_input() {
    let dir = std::env::temp_dir().join(format!("agentcue-icons-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let png = dir.join("图 标.png");
    fs::copy(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/desktop/src/renderer/assets/brand/app-icon.png"
        ),
        &png,
    )
    .unwrap();
    assert!(
        icons::read(png.to_str().unwrap())
            .unwrap()
            .starts_with("data:image/png;base64,")
    );
    assert!(icons::read("relative.png").is_err());
    assert!(icons::read(dir.to_str().unwrap()).is_err());
    let invalid = dir.join("invalid.png");
    fs::write(&invalid, b"<svg><script>alert(1)</script></svg>").unwrap();
    assert!(icons::read(invalid.to_str().unwrap()).is_err());
    fs::write(&invalid, vec![0u8; 2 * 1024 * 1024 + 1]).unwrap();
    assert!(icons::read(invalid.to_str().unwrap()).is_err());
    fs::remove_file(&png).unwrap();
    assert!(icons::read(png.to_str().unwrap()).is_err());
    fs::remove_dir_all(dir).unwrap();
}
