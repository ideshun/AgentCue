# AgentCue 1.0 原生版构建、升级与接入

AgentCue 1.0 正式版使用 Tauri 2 和系统 WebView。任务状态、SQLite、采集、通知、Hooks 和 MCP 由 Rust 提供，页面继续使用原有 TypeScript / CSS。系统音色由操作系统播放；Kokoro 和 ZipVoice 在独立的 `agentcue-tts` 进程内合成，模型从设置页按需下载。MiMo 仍需显式配置。完整插画保存在源码目录，构建沿用当前页面需要的工位素材。

## 构建与验证

安装 Node.js 22、项目指定的 pnpm、当前稳定版 Rust 与平台工具链。macOS 需要 Xcode 命令行工具；Windows 使用 MSVC Build Tools 和 WebView2；Ubuntu 24.04 需要 `libwebkit2gtk-4.1-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` 和 `patchelf`。

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm rust:verify
pnpm tauri:bundle
```

安装包位于 `target/release/bundle/`。默认构建 macOS App 与 DMG、Windows NSIS，或 Linux DEB 与 AppImage。可用 `pnpm tauri:bundle app` 等命令只构建一种。脚本固定 Tauri CLI 版本，从官方 Sherpa 运行库构建语音进程，生成应用所需页面，并检查 Tauri 和 Cargo 的版本一致性。若构建环境只提供 SOCKS 代理，可先将与宿主架构匹配的官方 Sherpa 2.0.1 静态库归档放入单独目录，再把 `SHERPA_ONNX_ARCHIVE_DIR` 指向该目录。

用打包后的可执行文件运行 `--self-test`，检查隔离数据库、文件增量消费、Hooks、MCP stdio、本机查询及语音进程启动。macOS 预览可以并行使用独立数据目录：

```bash
preview_dir="$(mktemp -d)"
open -n -a "$PWD/target/release/bundle/macos/AgentCue.app" \
  --args --isolated --data-dir "$preview_dir"
```

ZipVoice 参考音频使用至少 16 kHz 的单声道 PCM WAV，并填写与音频一致的文本。

## 数据与工具接入

正常启动使用 AgentCue 平台数据目录：macOS `~/Library/Application Support/AgentCue`、Windows `%LOCALAPPDATA%/AgentCue`、Linux `$XDG_DATA_HOME/agentcue`（默认 `~/.local/share/agentcue`）；Linux 设置位于 `$XDG_CONFIG_HOME/agentcue`（默认 `~/.config/agentcue`）。首次启动迁移旧 `AI Workflow Monitor` 数据，升级前请退出旧应用。迁移同盘移动大型模型，跨盘复制并保留旧目录；不会覆盖新版目录已有文件。涉及 schema 变更时，新引擎先备份数据库。可运行 `--isolated` 模式检验，不连接真实工具来源，也不使用生产数据库或配置。

macOS 如继续使用 `/Applications/AgentCue.app`，已有 Hooks / MCP 的命令路径和 CLI 参数仍可用。Windows 安装目录、Linux AppImage 文件位置或应用名称变化时，在「播报接入」复制新命令，替换客户端原有的 AgentCue 条目。Windows 提供 MCP stdio；POSIX Hooks 模板适用于 macOS 和 Linux。

## GitHub 发布

保持 Cargo workspace、Tauri 配置和版本说明对应同一个版本。推送 `v1.*` 标签后，**Native release** 在四个平台构建安装包、运行 Rust 检查并自检原生入口及语音进程，汇总 SHA-256。带预发布后缀的版本生成预发布草稿；不带后缀的稳定版本在所有平台构建通过后自动公布并标为 Latest。v0.x 沿用原有 Electron 发布流程。正式代码签名、公证和自动更新尚未配置。
