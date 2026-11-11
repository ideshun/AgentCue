# AgentCue 安装与发布

仓库：[ideshun/AgentCue](https://github.com/ideshun/AgentCue)。当前主版本为 **v1.0.0**，桌面宿主为 Rust + Tauri 2。旧版 v0.x Electron 安装包继续保留在 Releases 中。

## v1.x 原生版发布

`.github/workflows/native-release.yml` 在推送 `v1.*` 标签后运行：校验 Cargo 与 Tauri 版本及 Release notes，运行 Rust 验证、Clippy、TTS 测试和桌面自检，并在 macOS Apple 芯片 / Intel、Windows x64、Linux x64 原生 runner 上分别构建安装包。最后汇总安装包并生成 `SHA256SUMS.txt`。

- 标签含 `-`（例如 `v1.0.1-rc.1`）时，创建预发布草稿，保留人工检查流程。
- 稳定标签（例如 `v1.0.0`）时，所有构建和自检成功后自动发布为正式版，并标记为 Latest。
- 已发布版本默认不可覆盖；仅在用户明确要求的 v1.0.0 初期修订中，允许强制更新 `v1.0.0` 标签来重建并替换该 Release。其他已发布版本不可覆盖，后续修复应提升版本号并创建新标签。
- 当前没有 Developer ID 正式签名、macOS 公证或自动更新。CI 自检不替代目标系统上的人工交互和真实音频验收。

### 发布步骤

1. 同步更新根 `Cargo.toml` 的 workspace 版本、`apps/tauri/tauri.conf.json`、`Cargo.lock`、`CHANGELOG.md`、`README.md`，并新增 `docs/releases/vX.Y.Z.md`。
2. 本地验证核心并构建当前平台：

   ```sh
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm rust:verify
   cargo clippy -p agentcue-desktop -p agentcue-tts --all-targets --features agentcue-desktop/custom-protocol --locked -- -D warnings
   cargo test -p agentcue-tts --locked
   pnpm tauri:bundle app
   ```

   交叉平台安装包必须由对应系统和架构的 CI runner 生成，不可用单机产物代替。
3. 将已验证的版本提交推送到 `main`，再创建并推送带注释的标签：

   ```sh
   git tag -a vX.Y.Z -m "AgentCue vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

4. 在 Actions 确认 `Native release` 的四个平台构建与最后的发布步骤均成功。稳定版发布后，核对附件和 `SHA256SUMS.txt`；预览版则检查草稿后再手动发布。

本地 Tauri 构建产物位于 `target/release/bundle/`。可用 `pnpm tauri:bundle app`、`pnpm tauri:bundle dmg` 等只构建指定包。运行打包版 `AgentCue --self-test` 可检查隔离存储、原生入口、MCP stdio 和 TTS 进程启动。

## v0.x Electron 维护发布

`.github/workflows/release.yml` 与 `pnpm release:check` 专用于旧版 v0.x。该流程校验根 `package.json` 和 npm workspace 版本，运行 Electron 自检并构建历史安装包。新版本不应再用此工作流发布 1.0 原生应用。

## 安装、数据与工具接入

1. 完全退出旧版本，再安装新版本；红色关窗按钮只会隐藏窗口。
2. AgentCue 使用系统约定的数据目录；首次从旧版升级时会迁移 `AI Workflow Monitor` 中的任务、设置、模型和参考音频。同盘移动模型，跨盘复制并保留旧目录副本；冲突时保留新版文件与旧版副本，不会覆盖。
3. 如果仍安装在 `/Applications/AgentCue.app`，macOS 上原 Hooks / MCP 命令路径与参数保持兼容。移动应用、改名或从开发目录迁移时，在「播报接入」复制新配置并替换旧条目。
4. Windows 和 Linux 的命令路径随安装位置变化；迁移后应重新复制接入配置。Windows Hooks 自动生成尚未就绪，具体能力以界面状态为准。

Kokoro / ZipVoice 模型需在应用内主动下载，不包含在安装包中。云语音需显式开启，播报文字会发送给所配置的服务商。测试原生版时可使用 `--isolated` 和独立数据目录，避免读取或修改生产数据。

发版前不得提交用户数据库、会话、`runtime.json`、设置文件、语音模型或 API Key。插画原稿和设计素材保留在仓库，但未使用素材不进入安装包。
