# 隐私白皮书

AgentCue 默认本地运行。本页说明数据如何停留在本机，以及用户可以关闭的读取面。

## 数据存在哪

- 应用数据目录（macOS：`~/Library/Application Support/AI Workflow Monitor`）保存 SQLite、`settings.json`、`runtime.json`；更名后仍沿用历史目录。
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

## 导出

设置页可将事件检索结果导出为本地 JSON 文件，由用户自行保管。
