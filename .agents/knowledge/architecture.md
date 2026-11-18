# 架构与目录

## 适用范围

改 workspace 结构、跨包依赖、主进程/渲染进程/MCP 桥接、扫描→状态机→播报链路时读取。不问答产品定位时不必预加载。

## 来源路径 / 符号

- 仓库说明：[README.md](../../README.md)
- 设计依据：[docs/README.md](../../docs/README.md)、[docs/design/detailed-design.md](../../docs/design/detailed-design.md)
- 实现期偏离：[docs/adr/ADR-11-implementation-decisions.md](../../docs/adr/ADR-11-implementation-decisions.md)
- 包边界：`pnpm-workspace.yaml`（`packages/*`、`apps/*`），scope `@awm/*`
- 分层：`schema ← store ← core ← adapters / apps`

## 当前实现

当前安装版为 Rust + Tauri 2，复用原生 TypeScript/CSS 渲染层。原生工作区：

| 路径 | 职责 |
| --- | --- |
| `apps/tauri/src` | 窗口、托盘、系统通知、文件选择、登录启动、手动更新检查 |
| `crates/agentcue-core` | 无依赖状态机契约 |
| `crates/agentcue-store` | SQLite 迁移、事件与来源检查点事务 |
| `crates/agentcue-adapters` | 来源格式、Hooks 标准化与应用启动声明 |
| `crates/agentcue-runtime` | 采集、控制 API、MCP、语音编排、本机维护 |
| `crates/agentcue-tts` | 独立本地推理进程 |

后台任务运行在宿主 Tokio runtime，语音推理使用独立工作进程；HTTP 与 SSE 保持兼容。当前运行路径以 Rust 源码为准，TS 状态表和导出夹具用于兼容验证，不代表安装包执行 Electron 引擎。

以下 pnpm workspace 保留 v0.x 实现、共享渲染层、资源与契约夹具；`pnpm dev` 仍启动旧 Electron 开发入口：

| 包 | 路径 | 职责 |
| --- | --- | --- |
| `@awm/schema` | `packages/schema` | Zod 类型：事件、状态、manifest、settings、API |
| `@awm/store` | `packages/store` | Drizzle + better-sqlite3：DDL、迁移、DAO |
| `@awm/core` | `packages/core` | FSM、事件总线、探测、心跳、播报、MCP 工具契约 |
| `@awm/adapters` | `packages/adapters` | manifest 加载、注册表、会话发现、提取器 |
| `@awm/desktop` | `apps/desktop` | Electron 主进程、preload、渲染层、控制 API |
| `@awm/mcp-stdio` | `apps/mcp-stdio` | `awm-mcp` stdio 桥接，不碰数据库 |

历史 Electron 进程：主进程、渲染进程及 `awm-mcp`。原生安装版使用 `AgentCue --mcp-stdio` / `--tool-hook` 共用同一控制服务。

数据流：

```
会话文件 → 三层探测 → extractEvents → SessionEventBus → FSM → SQLite
                                    ├─ SSE 广播 → 渲染层
                                    ├─ 播报编排 → 原生 / 本地 / 用户启用的云 TTS 与系统通知
                                    └─ 托盘待介入计数
awm-mcp ──stdio──▶ HTTP Bearer ──▶ 同一套 FSM
```

状态机 7 态：`idle` / `running` / `waiting_human` / `failed` / `completed` / `cancelled` / `timeout`。TS 兼容迁移表是 `packages/core/src/statemachine/transition-table.ts` 的 `TRANSITION_TABLE`。

控制 API 绑定 `127.0.0.1`（`listen(0)` 随机端口），握手写 userData 下 `runtime.json`（0600）。实时推送是 SSE（`POST /api/v1/stream-ticket` 换一次性票据后连 `GET /api/v1/stream`），不是 WebSocket；限流 120 req/min，Hook 投递（`POST /api/v1/integrations/hooks`）与查询/控制分桶计数。

原生新增 DeepSeek Harness、OpenCode 2、Gemini CLI、Qwen Code 的安装识别和显式事件接入；模板位于 Rust `resources/extended-hook-templates.json`，原生插件源码在 `resources/integrations/`。DeepSeek 取提交后的 turn/end，OpenCode 忽略 idle；两者仅转发生命周期，暂不读取对话标题。Qwen 只接受带 submitted_prompt 的开始信号。自定义工具可选 iconPath，由原生端限量读取 PNG/JPEG/WebP 并返回 data URL，拖拽走 Tauri 文件事件，图标文件不上传不复制。

内置适配器 YAML 在 `packages/adapters/resources/adapters/`：`claude-code` 与 `codex` 有 `eventMapping`（CodeX JSONL 缺少可靠的人类待审批信号），任务身份粒度由 `sessionSource.identityMode` 声明（codex 为 `turn`，其余默认 `session`），提取器按声明分派、不按工具 id 特判；`cursor` 探测可用但 `eventMapping` 为空。JSONL 普通批次读取 4MB，首条记录跨块时按需扩读，单条记录上限 32MB；半行与读取资格撤销均不推进检查点，完整记录随消费事务提交，避免大图片/工具输出记录阻塞后续任务状态。

用户消息标题仍以最多 40 个 Unicode 字符供界面与通知使用；含明确 `@` 路径引用时，适配器另生成最多 60 字的去路径播报摘要，按来源保存在事件 payload 和／或来源检查点中，供后续播报使用。相关实现见 `packages/adapters/src/user-title.ts`、`packages/schema/src/speech.ts` 与 `packages/store/src/dao/events.ts`。

官方 Hooks 接入在 `apps/desktop/src/main/hook-setup.ts` 的 `HOOK_TOOLS`（顺序即「播报接入」页面的工具优先顺序）：`claude-code`、`cursor`、`cline`、`codebuddy`。各工具的标准化器在 `packages/adapters/src/{claude-code/hooks,tool-hooks,cline-hooks,codebuddy-hooks}.ts`；`--tool-hook` 子进程入口是 `apps/desktop/src/main/tool-hook-client.ts`，投递到 `POST /api/v1/integrations/hooks`。Claude Code 的 Hook 会话身份由 `transcript_path` 推导为 `claude-code:{project}:{sessionKey}`，与 JSONL 文件适配器共用同一任务记录。

渲染层文件：`apps/desktop/src/renderer/{index.html,styles.css,api.ts,ui.ts,views.ts,app.ts}`；办公室视图与样式独立在 `office.ts` / `office.css`，仍用原生脚本顺序加载。路由：`overview` / `office` / `board` / `notifications` / `integrations` / `adapters` / `settings`。`office` 使用 `assets/office/` 的本地插画及真实工具图标展示工位，仅为检测到已安装或运行中的工具分配连续工位编号；进行中消息默认常显；Rust 安装版的需确认气泡只取当前待处理状态且对应最新事件存在未读通知的任务，已读及没有通知的历史异常不触发自动气泡，其余信息经悬浮/键盘焦点气泡显示，点击打开可关闭的任务浮窗；素材随桌面构建复制，运行时不出网。`GET /api/v1/office` 完整计数、按状态分组取最多 5 条预览；Rust 返回独立 `attentionTasks` 和完整 `attentionCount` / `attentionCounts`（不依赖预览推导状态），等待确认的自动播报入队时也保存可标记的通知记录，通知已读后通过 `notifications.updated` 使办公室刷新，不把历史快照注入工作流或推导进度百分比。`integrations` 在侧栏显示为「播报接入」，按工具分组展示实际提供的 Hooks 与 MCP 配置；Gemini CLI / Qwen Code 用 mcpServers JSON，OpenCode 2 用 mcp.servers JSON，DeepSeek Harness 用 Cordis 插件 YAML，均使用安装位置的 stdio 入口。设置页保留语音、规则、隐私与外部 MCP Server 配置。

原生应用展示名为 `AgentCue`。数据目录遵循平台约定：macOS `~/Library/Application Support/AgentCue`、Windows `%LOCALAPPDATA%/AgentCue`、Linux `$XDG_DATA_HOME/agentcue`（默认 `~/.local/share/agentcue`）；Linux 设置单独位于 `$XDG_CONFIG_HOME/agentcue`（默认 `~/.config/agentcue`）。原生启动从旧 `AI Workflow Monitor` 目录迁移，旧版仍运行或持有锁时停止；同盘移动、跨盘复制、已有目标不覆盖。Hooks / MCP 使用相同默认数据根目录，协议标识保持兼容。规则见 [ADR-22](../../docs/adr/ADR-22-agentcue-data-directories.md)。

命令：`pnpm install`、`pnpm dev`、`pnpm build`、`sh scripts/l1-verify.sh`。跨包类型检查依赖各包 `dist/*.d.ts`，`pnpm typecheck` 前会 `pretypecheck` 全量 build。

Rust / Tauri 2 渐进迁移见 [ADR-21](../../docs/adr/ADR-21-rust-tauri-migration.md)。`crates/agentcue-core` 提供任务状态契约，`agentcue-store` 提供七版 SQLite 升级、显式文件备份与事件/检查点事务；`agentcue-adapters` 保留标题、JSONL、历史索引及原生 Hooks 的格式逻辑；`agentcue-runtime` 承载本机控制 API、定时采集、心跳、Hooks 与 MCP。兼容夹具由 TS 导出，并同时校验迁移 SQL、事件 ID、分批上下文、设置及接入模板。Tauri 宿主位于 `apps/tauri/`，使用 `bridge.js` 复用现有渲染层并接通窗口、托盘、通知和试听。原生语音由系统负责；`agentcue-tts` 独立合成 Kokoro / ZipVoice。预览使用隔离的合成数据，正式发布仍遵循[原生版交付手册](../../docs/native-preview.md)中的验收要求。

原生心跳覆盖已有的 Hooks 活跃任务，不因适配器基础能力为 `detect-only` / `metadata` 而跳过。进程证据来自适配器声明的 `processNames`，或其 `extensions.host` 对应适配器的进程声明；无法解析宿主或进程探测失败时，不推断工具已退出。连续三个心跳周期无文件变化、无新任务事件，且进程或所有已声明宿主均已退出时，记录 `heartbeat.lost` 并转为超时。旧 Hooks 任务以持久化的最后事件时间计算宽限期，重启不会将已过期任务重新延后；历史索引本身不产生活跃任务。

## 接入诊断

原生 `/api/v1/tools` 返回 `milestones`：仅包含可见任务中 `actor=tool` 的开始、待确认与完成事件的各类最近时间，不含正文、手动标记或历史快照。关闭读取或忽略工具后返回空列表。播报接入页用它展示诊断与按工具验证；验证起点保存在窗口内存，只有起点之后的来源事件算收到，不将多任务汇总误称为同一任务的端到端验证。

## 本机维护与原生偏好

数据库 schema v7 在 v6 的看板时间与工具事件索引基础上，增加按会话查询当前确认事件与未读通知的索引；看板按状态分别读取限量结果后合并，保持跨时区排序及分页。格式 1 的 schema v5 备份仍可恢复，并在启动时升级。

`maintenance.rs` 提供在线 SQLite 备份、重启前恢复及回滚、终态保留期限、白名单诊断导出、自定义读音。备份仅包含数据库和主 settings，不含模型、参考录音、API Key、系统登录启动配置和独立读音词典。恢复保留当前完整云语音配置，发生损坏会记录结果并保留现有数据；回滚失败则停止启动。自动清理默认关闭，仅清理过期完成、取消和 idle 记录及关联事件/通知，保留未解决状态与来源检查点。

数据管理 API 在 Tokio 阻塞工作线程执行；目录统计不持有共享数据库锁，备份的锁范围限于 SQLite 快照。

`features.rs` 负责系统登录启动与显式 GitHub 更新检查；不在刷新或启动时联网。`desktop.json` 保存窗口启动/关闭偏好，`maintenance.json` 保存保留期限，`pronunciation.json` 保存读音。模型可验证本机 SHA-256、移除、重新下载或从用户选择的本机目录导入；首次建立哈希不是发布者认证。详见 [ADR-23](../../docs/adr/ADR-23-native-operations.md)。

## 待确认

- 原生采集位于 Tokio 后台任务，尚无独立采集进程；先测内存再决定隔离。
- 实时通道为 SSE，见 `docs/adr/ADR-17-sse-instead-of-websocket.md`。
- Cursor `state.vscdb` 仍无公开契约，保持空 `eventMapping`。

## 更新触发

新增包或改变依赖方向、进程模型、数据与隐私边界、控制 API 传输、适配器清单、渲染层技术选型时更新本页。
