# ADR-22：按 AgentCue 和平台约定放置本机数据

- 状态：已采纳
- 日期：2026-11-11
- 适用版本：AgentCue 1.0.0 初期修订

## 背景

产品已更名为 AgentCue，但首个原生版本仍把所有数据放在 `AI Workflow Monitor` 目录。Windows 将大型模型放入 Roaming，导致用户配置漫游时产生不必要的同步与空间开销；Linux 则将数据库、模型和偏好设置全部放在 XDG 配置目录，混淆应用数据与配置。

## 决定

使用以下目录：

| 平台 | 数据（SQLite、握手、模型、参考音频） | 设置 |
| --- | --- | --- |
| macOS | `~/Library/Application Support/AgentCue` | 同数据目录 |
| Windows | `%LOCALAPPDATA%/AgentCue` | 同数据目录 |
| Linux | `$XDG_DATA_HOME/agentcue`，默认 `~/.local/share/agentcue` | `$XDG_CONFIG_HOME/agentcue`，默认 `~/.config/agentcue` |

XDG 环境变量只接受绝对路径。显式传入 `--data-dir` 时，设置仍存放在该目录，供隔离运行、自检及用户指定目录使用；Hooks 和 MCP 继续解析同一个默认数据目录。

## 升级与恢复

- macOS 从 `~/Library/Application Support/AI Workflow Monitor` 迁移。
- Windows 从 `%APPDATA%/AI Workflow Monitor` 迁移。
- Linux 从 `$XDG_CONFIG_HOME/AI Workflow Monitor` 迁移，未设置时从 `~/.config/AI Workflow Monitor` 迁移。
- 启动先取得新版单实例锁；若旧版仍健康或仍持有旧锁，停止启动并提示用户退出旧版。
- 同一磁盘上的内容移动到新位置；跨磁盘时复制，原数据保留。
- 新目录中已存在的文件优先保留；冲突的旧文件不覆盖且留在旧目录中。迁移中断后再次启动可继续处理缺失项。
- 符号链接不跟随；发现旧数据目录中的符号链接时停止迁移，避免越权复制。
- 如果 ZipVoice 参考音频路径位于旧目录，迁移后同步更新设置中的路径。

## 后果

首次启动会在用户数据目录进行迁移。大型模型通常以同盘重命名完成，不会产生第二份完整拷贝；跨磁盘场景可能暂时占用双倍空间，直到用户确认新版本工作正常后自行删除备份。Windows 模型不再纳入漫游目录。Linux 设置与可重建数据分开管理。

既有 Hooks / MCP 命令继续使用新版本默认数据目录；macOS 应用路径未变时原接入仍可用。未来若应用位置变化，用户需重新复制接入配置。
