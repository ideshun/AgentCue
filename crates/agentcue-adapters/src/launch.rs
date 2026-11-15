//! Declared GUI hosts for returning to a monitored task. CLI-only adapters have no GUI fallback.
pub fn macos_bundles(tool: &str) -> &'static [&'static str] {
    match tool {
        "codex" => &["Codex.app"],
        "cursor" | "cline" | "codebuddy" => &["Cursor.app"],
        _ => &[],
    }
}
