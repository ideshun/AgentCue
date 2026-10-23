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

pnpm workspace + TypeScript `strict`。包：

| 包 | 路径 | 职责 |
| --- | --- | --- |
| `@awm/schema` | `packages/schema` | Zod 类型：事件、状态、manifest、settings、API |
| `@awm/store` | `packages/store` | Drizzle + better-sqlite3：DDL、迁移、DAO |
| `@awm/core` | `packages/core` | FSM、事件总线、探测、心跳、播报、MCP 工具契约 |
| `@awm/adapters` | `packages/adapters` | manifest 加载、注册表、会话发现、提取器 |
| `@awm/desktop` | `apps/desktop` | Electron 主进程、preload、渲染层、控制 API |
| `@awm/mcp-stdio` | `apps/mcp-stdio` | `awm-mcp` stdio 桥接，不碰数据库 |

进程：主进程（引擎 + HTTP 控制 API + 托盘 + 窗口）、渲染进程、由客户端拉起的 `awm-mcp`。扫描与心跳目前在主进程 `setInterval` 内，不是独立子进程。

数据流：

```
会话文件 → 三层探测 → extractEvents → SessionEventBus → FSM → SQLite
                                    ├─ SSE 广播 → 渲染层
                                    ├─ 播报编排 → macOS say / 系统通知
                                    └─ 托盘待介入计数
awm-mcp ──stdio──▶ HTTP Bearer ──▶ 同一套 FSM
```

状态机 7 态：`idle` / `running` / `waiting_human` / `failed` / `completed` / `cancelled` / `timeout`。迁移合法性唯一权威是 `packages/core/src/statemachine/transition-table.ts` 的 `TRANSITION_TABLE`。

控制 API 绑定 `127.0.0.1`（`listen(0)` 随机端口），握手写 userData 下 `runtime.json`（0600）。实时推送是 SSE（`GET /api/v1/stream`），不是 WebSocket。

内置适配器 YAML 在 `packages/adapters/resources/adapters/`：`claude-code` 与 `codex` 有 `eventMapping`（Codex 无 waiting_human，审批不落 JSONL）；`cursor` 探测可用但 `eventMapping` 为空。

官方 Hooks 接入在 `apps/desktop/src/main/hook-setup.ts` 的 `HOOK_TOOLS`（顺序即设置页顺序）：`claude-code`、`cursor`、`cline`、`codebuddy`。各工具的标准化器在 `packages/adapters/src/{claude-code/hooks,tool-hooks,cline-hooks,codebuddy-hooks}.ts`；`--tool-hook` 子进程入口是 `apps/desktop/src/main/tool-hook-client.ts`，投递到 `POST /api/v1/integrations/hooks`。Claude Code 的 Hook 会话身份由 `transcript_path` 推导为 `claude-code:{project}:{sessionKey}`，与 JSONL 文件适配器共用同一任务记录。

渲染层文件：`apps/desktop/src/renderer/{index.html,styles.css,api.ts,ui.ts,views.ts,app.ts}`。路由：`overview` / `board` / `notifications` / `adapters` / `settings`。

命令：`pnpm install`、`pnpm dev`、`pnpm build`、`sh scripts/l1-verify.sh`。跨包类型检查依赖各包 `dist/*.d.ts`，`pnpm typecheck` 前会 `pretypecheck` 全量 build。

## 待确认

- 设计要求扫描子进程（RK-07）；实现仍在主进程。未测内存前不要拆。
- 实时通道为 SSE，见 `docs/adr/ADR-17-sse-instead-of-websocket.md`。
- Cursor `state.vscdb` 仍无公开契约，保持空 `eventMapping`。

## 更新触发

新增包或改变依赖方向、进程模型、控制 API 传输、适配器清单、渲染层技术选型时更新本页。
