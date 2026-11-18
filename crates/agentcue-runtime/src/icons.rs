//! Read only explicitly configured local raster icons; never expose arbitrary files through a URL.
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{io::Read, path::Path};
pub fn read(path: &str) -> Result<String, String> {
    let expanded = crate::discovery::Environment::system(&[])
        .map_err(|_| "无法确定用户目录")?
        .expand(path);
    let path = Path::new(&expanded);
    if !path.is_absolute() {
        return Err("图标路径必须是本机绝对路径".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "图标文件不可读")?;
    if !file.metadata().map_err(|_| "图标文件不可读")?.is_file() {
        return Err("请选择图片文件".into());
    }
    let mut bytes = Vec::new();
    file.take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "图标文件不可读")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("图标不能超过 2MB".into());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("请选择 PNG、JPEG 或 WebP 图片".into());
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
