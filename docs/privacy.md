# 隐私白皮书

AgentCue 默认本地运行。本页说明数据如何停留在本机，以及用户可以关闭的读取面。

## 数据存在哪

- 应用数据目录按平台放置：macOS `~/Library/Application Support/AgentCue`；Windows `%LOCALAPPDATA%/AgentCue`；Linux `$XDG_DATA_HOME/agentcue`，未设置时为 `~/.local/share/agentcue`。SQLite、`runtime.json`、模型与参考音频保存在此处。
- 设置文件保存在 macOS / Windows 的应用目录 `settings.json`；Linux 使用 `$XDG_CONFIG_HOME/agentcue/settings.json`，未设置时为 `~/.config/agentcue/settings.json`。升级时会从旧的 `AI Workflow Monitor` 目录迁移数据；同盘移动模型，跨盘复制并保留旧目录副本。迁移不会覆盖新版目录中已有文件。
- `runtime.json` 权限为 `0600`，含本机控制 API 的随机端口与 token。不要把它拷贝到仓库或发给他人。
- 会话原文只从适配器声明的路径读取（例如 `~/.claude/projects/**/*.jsonl`、`~/.codex/sessions/**/*.jsonl`），不递归家目录。

## 默认不出网

- 扫描、状态机、看板、MCP stdio 桥都不访问公网。
- 控制 API 绑定 `127.0.0.1`。
- 云 TTS（小米 MiMo）必须在设置里显式开启**并填写 API Key** 才会把播报文本 POST 给服务商；Key 只存本机 `settings.json`，不写入日志或审计。关闭后不再请求。
- 本地 TTS：原生音色与 Kokoro 全程离线；ZipVoice 用你选择的参考录音复刻音色，录音会复制到应用数据目录 `voice-references/`，不会上传。Piper 只调用本机二进制。

## 用户可关的开关

- **读取会话文件**：关闭后仍探测工具是否安装，但不再解析会话 JSONL。
- **审计日志**：关闭后非法迁移与控制 API 错误不再写入 `audit_log`。
- **忽略工具**：忽略后不再扫描该适配器。

## 不做的事

- 不上传会话内容、token、审计日志。
- 不向被监控工具写入指令。任务状态回写只通过用户显式调用的 MCP `update_task_state` 白名单事件。
- 不为「看起来完整」编造 Cursor `state.vscdb` 事件映射。

## 本机维护与导出

「应用与数据」提供显式备份与恢复。备份包含数据库中的任务信息和主设置，不包含 API Key、模型和参考音频；恢复保留当前云语音配置。备份保存在本机 `backups/`，不会自动上传。

诊断导出采用白名单，只包含版本、平台、工具连接状态、事件类型时间和汇总计数，不包含标题、正文、路径、命令、错误原文和凭据；先预览，用户点击后才导出。

用户点击「检查更新」时向 GitHub 请求最新正式版元数据，不发送任务或设置。自定义读音在本机保存；启用云语音时，读音提示随播报文本一起发送给服务商。历史保留期限默认关闭，启用或手动清理均需明确确认。
