#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

mod desktop;
mod self_test;
mod services;

use agentcue_runtime::{hook_cli, mcp, paths};
use std::{ffi::OsString, path::PathBuf};

fn argument<'a>(args: &'a [OsString], flag: &str) -> Option<&'a OsString> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
}

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let has = |flag: &str| args.iter().any(|arg| arg == flag);
    let explicit_data_dir = argument(&args, "--data-dir").map(PathBuf::from);
    if has("--data-dir") && explicit_data_dir.as_ref().is_none_or(|p| !p.is_absolute()) {
        return Err("--data-dir 必须是绝对路径".into());
    }
    let isolated = has("--isolated");
    if isolated && explicit_data_dir.is_none() {
        return Err("--isolated 需要明确指定 --data-dir".into());
    }

    if has("--self-test") || has("--mcp-stdio") || has("--tool-hook") {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let result = runtime.block_on(async {
            if has("--self-test") {
                return self_test::run().await;
            }
            let dir = explicit_data_dir
                .clone()
                .map(Ok)
                .unwrap_or_else(paths::default_data_dir)
                .map_err(|e| e.to_string())?;
            if has("--mcp-stdio") {
                return mcp::run_stdio(tokio::io::stdin(), tokio::io::stdout(), dir)
                    .await
                    .map_err(|e| e.to_string());
            }
            let tool = argument(&args, "--tool-hook")
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            let phase = argument(&args, "--hook-phase").and_then(|s| s.to_str());
            hook_cli::run(tokio::io::stdin(), tokio::io::stdout(), tool, phase, &dir).await;
            Ok(())
        });
        // A hook's stdin may remain open after its deadline. Do not join that blocking read.
        runtime.shutdown_background();
        return result;
    }

    let paths = explicit_data_dir
        .map(paths::AppPaths::for_data_dir)
        .map(Ok)
        .unwrap_or_else(paths::default_app_paths)
        .map_err(|e| e.to_string())?;
    desktop::run(paths, isolated)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("AgentCue：{error}");
        std::process::exit(1);
    }
}
