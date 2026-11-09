#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"
rust_cargo=cargo
if ! command -v "$rust_cargo" >/dev/null 2>&1; then
  rust_cargo="$HOME/.cargo/bin/cargo"
fi
if [ ! -x "$rust_cargo" ] && ! command -v "$rust_cargo" >/dev/null 2>&1; then
  printf '%s\n' '请先安装 rustup，并按 rust-toolchain.toml 安装工具链。' >&2
  exit 1
fi

"$rust_cargo" fmt --all -- --check
"$rust_cargo" clippy --workspace --exclude agentcue-desktop --exclude agentcue-tts --all-targets --locked -- -D warnings
"$rust_cargo" test --workspace --exclude agentcue-desktop --exclude agentcue-tts --locked
