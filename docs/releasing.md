# AgentCue 安装与发布

## 当前流程

GitHub 仓库：[ideshun/AgentCue](https://github.com/ideshun/AgentCue)。仓库保留为私有。

- `.github/workflows/l1.yml` 在 `main`、PR 与手动触发时运行完整检查并存档日志。
- `.github/workflows/release.yml` 接受版本标签或手动指定现有标签，检查全部包版本，运行完整 L1，然后在原生 runner 构建 macOS arm64 / x64、Windows x64、Linux x64。
- 每个平台构建后自检 Electron 包中的 SQLite 内存访问、系统架构 TTS 运行库、当前工位插画、许可和 6 个 MCP 工具。自检不打开窗口或播放音频。
- 成功后生成 SHA-256 校验文件，创建或更新 **草稿预览版**。检查附件和校验值后再通过 GitHub UI 发布。工作流不会覆盖已经发布的版本。
- 正式 Code Signing、公证和自动更新暂未配置。

发布工作流需要仓库开启 GitHub Actions。首次使用时为 `main` 增加 tag push 权限提示，日志会说明失败步骤。

## 发布新版本

1. 更新根 `package.json` 版本号、各 workspace 包版本号和 `pnpm-lock.yaml`，保持一致。
2. 在 `CHANGELOG.md` 中记录版本说明，并新建 `docs/releases/vX.Y.Z.md` 作为这版 Release notes。
3. 本地运行 `pnpm release:check vX.Y.Z` 与 `sh scripts/l1-verify.sh`。
4. 建立已检查的版本提交后，推送标签：

   ```sh
   git tag -a vX.Y.Z -m "AgentCue vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

5. GitHub Actions 等待 quality 和四个平台构建及自检通过后，生成草稿预览版与 SHA-256 清单。审查附件，再发布 Release。

手动补跑已存在的标签可在 Actions → Release → Run workflow 输入 `vX.Y.Z`。标签版本必须和各包完全相同；同一标签重新运行仅更新仍为草稿的 Release，已发布版本必须使用新标签。

本地建包：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm release:verify apps/desktop/release/mac-arm64/AgentCue.app
pnpm --filter @awm/desktop exec electron-builder --mac --arm64 --publish never
pnpm release:checksums apps/desktop/release
```

CI 在其各自的原生系统与架构上构建；不能将单机 Mac arm64 构建冒充 Intel、Windows 或 Linux 安装包。

## 首次安装会占用多少空间

安装后的 `.app` 带有 Electron Framework（Chromium 与 Node.js），基础框架约 **289 MiB**。本次 macOS arm64 优化包分配量约 **337 MiB**；已有 `/Applications/AgentCue.app` 原包约 **391 MiB**。因此首次安装也会是数百 MB，这部分来自桌面运行环境，和任务记录无关。

本次减少约 54 MiB：此前会同时带上重复的 sherpa TTS 运行库与 SQLite 编译源码/中间文件。新打包规则把 TTS 原生库只放在 `Resources/sherpa-tts`，并只把当前引用的工位图复制到安装包。**所有**插画源码、未使用版本和设计素材仍留在仓库。Kokoro / ZipVoice 语音模型需用户主动下载，均不包含在安装包内。

Finder 的「显示简介」/ 容量、下载压缩包大小和逻辑文件大小是不同口径。Release 会列出每个实际安装包的字节数及 SHA-256；以新包自检构建结果为准，不根据旧安装包估计优化后的大小。

## 安装和接入迁移

## 本机安装

1. 先在托盘菜单选择「退出」，或使用 Cmd+Q 完全退出旧实例；红色关窗按钮只会隐藏窗口。
2. 将已构建的 `AgentCue.app` 放进 `/Applications`。
3. 从 `/Applications` 启动，以后保持这个固定安装位置。
4. 打开「播报接入」，从已安装的应用复制新的 Hooks / MCP 配置。
5. 重新加载对应工具窗口或新建会话，发送一条新任务，核对最近接入时间。

应用展示名为 **AgentCue**（`APP_DISPLAY_NAME`），历史数据目录名继续使用 `AI Workflow Monitor`（`APP_NAME`）。主进程在请求单实例锁前显式设置 `userData = defaultDataDir()`；macOS 仍沿用 `~/Library/Application Support/AI Workflow Monitor/`，Hooks 与 MCP 也从这里读取握手信息。更名不迁移或清空设置、任务记录和模型。

本地构建：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @awm/desktop exec electron-builder --mac --arm64 --publish never
```

`pnpm build` 构建全部 workspace 包，打包使用各包的 `dist`。需保证运行目标的原生模块与 Electron 版本、操作系统、CPU 架构匹配。当前项目的本地语音运行时在 `after-pack.cjs` 中按目标架构复制。

## Hooks 和 MCP 是否需要重接

| 迁移情况 | 处理 |
| --- | --- |
| 开发版迁到安装版 | 重新复制一次接入配置，将开发目录里的可执行文件路径换成安装版路径 |
| 同一安装路径下更新版本 | 接口兼容时通常沿用现有配置；更新后发送新任务验证 |
| 移动、改名应用，或删除原来引用的开发目录 | 重新生成并合并接入配置 |
| CodeX 文件采集 | 当前不依赖 Hooks；读取会话文件，需保持来源读取开启 |
| MCP 客户端 | 与 Hooks 一样使用绝对启动路径；从开发版迁到安装版时重新复制一次 |

`desktopMcpLaunch()` 根据当前可执行文件和是否打包生成命令；`toolHookCommand()` 复用这个绝对路径替换子进程入口。因此应先完成安装，再复制配置。迁移时替换旧的 AgentCue（原 AWM）启动命令，保留其他工具已有的 Hooks；每个事件保留一条对应的 AgentCue 调用，避免重复追加。MCP 同样更新原 `ai-workflow-monitor` Server 配置。

从旧的 `AI Workflow Monitor.app` 换成 `AgentCue.app` 时，可执行文件的绝对路径会变化。安装后从「播报接入」更新原 Hooks / MCP 条目一次；MCP Server 键仍为 `ai-workflow-monitor`，CLI 仍为 `awm-mcp`，不要新增第二份配置。

当前自动生成的 Hooks 命令采用 POSIX shell 引号，Windows 的就绪状态仍被标为不可用。发布 Windows 接入能力前需要补充 Windows 启动器并做平台验收。

预览版不应上传用户数据库、会话、`runtime.json`、settings、语音模型或 API Key。仓库忽略本机模型和数据库；发版前仍要审查新增文件与构建范围。
