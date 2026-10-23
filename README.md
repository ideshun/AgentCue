# AI Workflow Monitor · AI 工作流监控

本地优先的 AI 编码工具任务监控与语音提醒桌面软件。自动识别 Claude Code 等 AI 编码工具的任务状态，需要你拍板时语音喊你。

- 设计文档：[docs/README.md](./docs/README.md)
- 当前版本：**v0.1.0（M0–M3 主路径已落地；M4 仅内测打包架，无真实签名账号）**
- 标识符：仓库 `ai-workflow-monitor`、包 scope `@awm/*`、MCP 命令 `awm-mcp`、数据目录 `AI Workflow Monitor`

---

## 一、当前已交付

### M0 技术验证

| 任务                                                                  | 状态 | 落地位置                                                |
| --------------------------------------------------------------------- | ---- | ------------------------------------------------------- |
| pnpm workspace + Electron 空壳 + 托盘 + 单实例锁                      | ✅   | `apps/desktop/src/main/{index,window,tray}.ts`          |
| schema 包（事件/manifest/settings/API）+ store 包（DDL + 迁移 + DAO） | ✅   | `packages/schema`、`packages/store`                     |
| FSM 骨架（7 态迁移表 + 回跳守卫 + 迁移矩阵单测）                      | ✅   | `packages/core/src/statemachine`                        |
| claude-code 适配器：manifest + JSONL 提取器 + fixture 契约测试        | ✅   | `packages/adapters/src/claude-code/extract.ts`          |
| 播报最短链：规则直通 → macOS `say`                                    | ✅   | `packages/core/src/voice/{rule-engine,tts,pipeline}.ts` |

### M1 可用版本

| 任务                                                         | 状态 | 落地位置                                                                                             |
| ------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------- |
| 三层探测器（配置 → 进程 → 运行时 API，四态合并）             | ✅   | `packages/core/src/scanner/detector.ts`                                                              |
| 扫描编排（并发上限、单适配器降级、忽略清单）                 | ✅   | `packages/core/src/scanner/orchestrator.ts`                                                          |
| 会话文件发现与增量读取                                       | ✅   | `packages/adapters/src/discover.ts`、`apps/desktop/src/main/monitor-service.ts`                      |
| 心跳监控 + 超时判定（30 分钟等待超时）                       | ✅   | `packages/core/src/heartbeat/monitor.ts`、`monitor-service.ts`                                       |
| 播报 v1：免打扰、去抖合并、优先级队列、失败降级通知          | ✅   | `packages/core/src/voice/{quiet-hours,debouncer,queue}.ts`、`apps/desktop/src/main/voice-service.ts` |
| 控制 API（12+ 端点、SSE、限流、审计、CORS）                  | ✅   | `apps/desktop/src/main/api-server.ts`                                                                |
| 主界面：总览 / 分列分页看板 / 时间线标记 / 适配器 / 分区设置 | ✅   | `apps/desktop/src/renderer/*`                                                                        |
| 设置持久化（原子写、损坏备份、schema 校验）                  | ✅   | `apps/desktop/src/main/settings-store.ts`                                                            |
| 托盘状态化（待介入数量、静音、立即扫描）                     | ✅   | `apps/desktop/src/main/tray.ts`                                                                      |

### M2 生态接入

| 任务                                                   | 状态 | 落地位置                                            |
| ------------------------------------------------------ | ---- | --------------------------------------------------- |
| `awm-mcp` stdio 桥接（6 个 MCP 工具、协议 2025-06-18） | ✅   | `apps/mcp-stdio/src/{server,client,tools,index}.ts` |
| 进程间握手（runtime.json 0600）                        | ✅   | `packages/core/src/runtime/paths.ts`                |
| MCP 工具契约测试（名字与 core 一致）                   | ✅   | `tests/contract/mcp-tools.test.ts`                  |

### M2 / M3 已补

| 任务                                                  | 状态 | 落地位置                                                                                     |
| ----------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| Codex 公开 rollout 事件映射 + fixture                 | ✅   | `packages/adapters/resources/adapters/codex.manifest.yaml`、`tests/contract/adapters/codex/` |
| Claude Code、Cursor、Cline、CodeBuddy 官方 Hooks 接入 | ✅   | 任务播报接入设置、轻量 Hook CLI、本地鉴权 API与事务去重                                      |
| 通知中心 + MCP 配置片段 + 外部 MCP 枚举               | ✅   | `packages/store/src/dao/notifications.ts`、`mcp-snippets.ts`、`mcp-client.ts`                |
| 规则矩阵 / 适配器校验 CLI / TTS 降级链                | ✅   | 设置页、`awm-adapter-validate`、`packages/core/src/voice/tts.ts`                             |
| 事件 JSON 导出                                        | ✅   | `GET /api/v1/events?download=1`、设置页按钮                                                  |

### 可靠性与体验修订

- 安装识别默认每 6 小时执行；任务事件每 5 秒独立采集，持久化字节位置、稳定事件 ID 与消费收据。
- Codex 按 `turn_id` 区分同一聊天中的任务轮次，标题仅来自用户请求；旧错误标题可独立回填，不重放事件。
- Codex 的内部审批/压缩/记忆整理来源与全部子 Agent（`subagent: "review"`、`subagent: { thread_spawn: … }` 等）不进入看板、活跃计数和播报；已有记录只隐藏，保留原状态与事件。普通来源（`cli`、`vscode`、`exec`、`mcp`、自定义来源）仍保留，合法用户 JSON 不会被当作无效标题。子 Agent 常被用来并行跑工具，这正是「分配子 Agent 也播报」的来源。
- Cline、CodeBuddy 按 Cursor 扩展清单身份识别。Claude Code、Cursor、Cline、CodeBuddy 均可通过官方 Hooks 接收开始/结束事件；Claude Code 还会把 `permission_prompt` 通知作为等待确认，Cursor 把 `preToolUse` 中 `tool_name` 为 `AskQuestion` 的调用视为等待确认。Claude Code 的 Hook 会话身份由 transcript 路径推导，与文件采集共用同一任务记录。客户端配置由用户粘贴。Cline 历史索引仍单独分组，不读取对话存储。[任务播报接入](docs/integrations/task-hooks.md)。
- 看板按列查询与计数，支持工具/关键词筛选和每列加载更多；“仅历史/状态未知”不参与状态机、活跃数、心跳或超时。
- 设置页手动保存：改动先保留在本地，点右上角「保存」才写入（类型校验 + 原子写）；离开设置页、关闭窗口或退出应用时若有未保存改动会询问保存/不保存/取消。自动刷新保留编辑草稿和焦点，不会覆盖未保存的改动；试听始终使用上次保存的后端与音色。全局静音立即停止自动播报。
- macOS 音色列表只列本机已安装、可播报的音色：善怡粤语、婷婷普通话、Shelley/Sandy/Reed/Rocko/Eddy/Flo 增强款普通话，以及 Samantha/Alex/Daniel/Karen/Moira/Tessa/Rishi/Aman 等常用英文音色。自动播报只用中文音色兜底（优先普通话增强款，其次婷婷普通话，粤语善怡排最后），英文音色必须手动选择。本地 Kokoro 有 100 个普通话音色与 3 个英语音色；本地 ZipVoice 用一段参考录音复刻音色，需另选 WAV 并逐字填写录音原文。两者都只在用户点击后下载模型，默认离线。
- 播报文本在交给引擎前做确定性归一化：时间、百分比、版本号、容量/耗时换成口语读法；看板与通知原文不变。云 TTS（小米 MiMo）默认关闭，必须显式开启并填写 API Key 才会把播报文本发送到服务商；Key 只存本机，失败只报错，不改播其他音色。
- MCP 桥接随桌面构建分发；外部 Server 显示一次验证结果与时间，不宣称持续连接。

### 播报出厂规则

| 事件         | 默认（范围＝仅待确认） | 范围含里程碑时 |
| ------------ | ---------------------- | --------------- |
| 任务开始     | 通知                   | 语音播报        |
| 需要用户确认 | 语音播报               | 语音播报        |
| 任务完成     | 通知                   | 语音播报        |

自动语音范围可在“设置 → 语音播报 → 播报范围”选择：仅待确认（默认）、待确认与开始/完成。旧版“全部事件”兼容为这三个阶段，不再提供重复选项。失败、超时、重试等其他事件按规则通知或静音；原有静音和自定义规则保留。保存播报范围或内容模式时会取消旧播放和排队项，未静音的任务提醒保留为通知；出声前也会复核最新范围与文案。

云 TTS 的语速由平台控制，选择云后端时本机语速滑块禁用，切回本地或系统后保留原有数值。含 API Key 的设置文件在 macOS/Linux 上以 `0600` 权限原子写入，读取旧版文件时收紧权限，损坏备份也仅当前用户可读写。

看板刷新会重读各列已加载的分页，超过 100 条也保留展开深度，同时移除已迁移或归档的记录。后台刷新按事件更新相关分区，缓存较稳定的设置与工具数据，并按实际分页请求数调整间隔，为 Hooks 和手动操作留出 API 限流余量；手动刷新立即读取。

播报内容同样可配置：“会话标题（精简）”（默认）去掉代码、链接和 Markdown 记号，截到第一个句读，最多 24 字；“标题原文”保留适配器给出的前 40 字。两者都是用户输入的首条文本（各工具没有独立的会话名），无可靠标题时使用与界面一致的短编号。

提醒以实际接入事件为准：Claude Code、Cursor、Cline、CodeBuddy 需配置 Hooks 后才有实时开始/结束事件；Claude Code 另有 `permission_prompt` 通知、Cursor 另有 `preToolUse` 的 `AskQuestion` 工具调用映射为等待确认，其余 Hooks 和 Codex 文件适配器没有可靠的待审批映射。全局静音、免打扰和去重规则仍然生效；默认 22:30–08:30 免打扰，待确认例外可突破时段，不能突破全局静音。设置页显示当前策略；两秒冷却中的新任务排队而非丢弃。

同一稳定事件 ID 在播报服务运行期间只接受一次，播放结束和设置变更后也保留去重记录。应用启动前、重新开启采集前的历史补采只更新任务记录与界面；自动提醒处理时间基线之后的真实事件，扫描补全的起始事件保持静默。显式试听每次点击各播放一次。

### 明确未做或后置

- Cursor `state.vscdb` 事件映射：无公开契约，禁止编造
- GitHub Copilot 适配器：无独立进程与稳定会话格式，刻意不写
- 真实 macOS 公证 / Windows Authenticode：仅 electron-builder 配置架，无账号密钥
- 10×100 会话 Electron 浸泡压测：现为进程内预算测试 `tests/perf/latency-report.test.ts`
- Piper / 云端尚无完整模型与音频播放适配，明确显示不可用；默认使用系统原生语音
- 多语言界面（当前仅中文）

---

## 二、快速开始

```bash
cd /Users/deshun/Data/Project/ai-workflow-monitor

# 1) 首次：启用 pnpm 并安装依赖
corepack enable pnpm
pnpm install

# 2) 一键验证（typecheck + test + lint，日志落盘 .verify/l1.log）
sh scripts/l1-verify.sh

# 3) 启动桌面应用
pnpm dev
```

> `pnpm typecheck` 前会先跑 `pretypecheck`（`pnpm -r run build`），
> 因为跨包类型解析依赖各包 `dist/*.d.ts`；单测则通过 vitest alias 直连源码，不依赖构建产物。

`better-sqlite3` 是原生模块。`pnpm test` 会先检查内存数据库是否与当前 Node ABI
兼容；不兼容时自动使用项目 Electron 的 Node 运行时，不重编译共享模块。
`pnpm dev` 仍通过 `electron-builder install-app-deps` 对齐桌面运行时。
L1 会保留三项检查结果，任一失败均返回非零退出码。

打包（`pnpm dist`，产物在 `apps/desktop/release/`）前需确认 `apps/desktop/dist/`
已生成（`pnpm build` 或 `pnpm dev` 都会产出）。electron-builder 的 `files`
显式包含 `node_modules/**/*`（声明 files 会整体替换默认 patterns，漏写这条
会把生产依赖全部漏掉）；better-sqlite3 通过 `asarUnpack` 解包到磁盘。

---

## 三、运行期数据流

```
会话文件（JSONL）
   │  安装识别（每 6h/手动）+ 独立采集（每 5 秒）
   ▼
MonitorService ── 三层探测 ──▶ tools 表（四态）
   │  增量读取（已提交字节位置；与心跳观测分开）
   ▼
extractEvents（按 manifest 映射）──▶ 标准事件
   │
   ▼
会话串行消费 ──▶ FSM（7 态）──▶ 事务落库（事件 + 收据 + 来源检查点）
   │
   ├─▶ SSE 广播 ──▶ 渲染层刷新
   ├─▶ 播报编排（规则 → 去抖 → 静音/时段判定 → TTS）──▶ say / 系统通知
   └─▶ 托盘状态（待介入数量）

MCP 客户端 ──stdio──▶ awm-mcp ──HTTP(Bearer)──▶ 控制 API ──▶ 同一套 FSM
```

进程模型：主进程（引擎 + API + 托盘 + 窗口）、渲染进程、扫描/心跳定时器（主进程内）、
独立的 `awm-mcp` 桥接进程（由 AI 客户端拉起）。

---

## 四、目录结构

```
ai-workflow-monitor/
├─ docs/                       # 设计文档归档 + ADR
├─ packages/
│  ├─ schema/                  # Zod + TS 类型：事件、状态、manifest、settings、API
│  ├─ store/                   # Drizzle 表定义、迁移、DAO（跨表事务落库）
│  ├─ core/                    # FSM、事件总线、归一化、探测、心跳、播报、MCP 工具契约
│  └─ adapters/                # manifest 加载器、注册表、会话文件发现、内置适配器
├─ apps/
│  ├─ desktop/                 # Electron 主进程 / preload / 渲染层
│  └─ mcp-stdio/               # awm-mcp stdio 桥接
├─ tests/
│  ├─ contract/                # 契约测试：零工具名、manifest、claude-code/codex fixture、MCP 工具名
│  ├─ perf/                    # 进程内时延预算（非 Electron 浸泡）
│  ├─ integration/             # 监控服务集成测试（扫描 → 落库全链路）
│  └─ unit/                    # MCP 协议单测
└─ scripts/l1-verify.sh        # L1 验证脚本（输出落盘）
```

分层依赖：`schema ← store ← core ← adapters/apps`，跨包引用一律用包名（ESLint 边界规则已生效）。

---

## 五、控制 API 速查

默认监听 `127.0.0.1:<随机端口>`，端口与 token 见 `<userData>/runtime.json`。
除 `OPTIONS` 预检与 SSE 外，全部要求 `Authorization: Bearer <token>`。

| 方法     | 路径                            | 说明                                       |
| -------- | ------------------------------- | ------------------------------------------ |
| GET      | `/api/v1/health`                | 健康检查                                   |
| GET      | `/api/v1/overview`              | 总览聚合（各状态计数、工具统计、最近扫描） |
| GET      | `/api/v1/tools`                 | 工具列表与探测状态                         |
| POST     | `/api/v1/tools/:id/ignored`     | 忽略/恢复工具                              |
| GET      | `/api/v1/adapters`              | 已加载的 manifest                          |
| GET      | `/api/v1/sessions`              | 会话列表（state/toolId/limit）             |
| GET      | `/api/v1/sessions/:id`          | 当前状态 + 最近 5 条迁移                   |
| GET      | `/api/v1/sessions/:id/timeline` | 时间线                                     |
| POST     | `/api/v1/sessions/:id/events`   | 注入事件                                   |
| POST     | `/api/v1/tasks/:id/state`       | 注入事件（等义端点）                       |
| POST     | `/api/v1/scan`                  | 触发扫描                                   |
| GET      | `/api/v1/events`                | 历史事件检索；`?download=1` 导出 JSON      |
| GET      | `/api/v1/notifications`         | 通知中心                                   |
| POST     | `/api/v1/notifications/read`    | 标记已读                                   |
| GET      | `/api/v1/mcp/snippets`          | 各客户端 MCP 配置片段                      |
| POST     | `/api/v1/mcp/validate`          | 验证应用自带 stdio 桥接并枚举工具          |
| GET/POST | `/api/v1/mcp/servers`           | 外部 MCP Server 列表 / 配置验证与枚举      |
| DELETE   | `/api/v1/mcp/servers/:id`       | 移除外部 MCP Server                        |
| GET/PUT  | `/api/v1/settings`              | 读取/增量更新设置                          |
| GET/POST | `/api/v1/voice/rules`           | 播报规则                                   |
| POST     | `/api/v1/voice/test`            | 试听                                       |
| GET      | `/api/v1/voice/voices`          | 本机系统音色列表（当前 macOS）             |
| GET      | `/api/v1/stream?token=`         | SSE 实时推送                               |

---

## 六、MCP 接入

打开应用设置的“让客户端使用 AWM”，选择 Claude Code、Cursor、Cline、CodeBuddy 等客户端，
按步骤复制配置并验证。配置使用当前应用可执行文件的绝对路径及 `--mcp-stdio`
参数；开发版额外包含应用目录。桥接资源由桌面构建复制，不要求全局链接或额外安装 Node。
Codex 片段使用 TOML，其余客户端使用各自的 JSON 格式。应用不会修改客户端配置文件。

六个工具：`list_tools` / `list_sessions` / `get_task_status` / `update_task_state` /
`set_voice_rule` / `get_timeline`。全部返回统一 envelope，错误码为
`NOT_FOUND` / `INVALID_PARAM` / `ILLEGAL_TRANSITION` / `RATE_LIMITED` / `ENGINE_UNAVAILABLE`。

`update_task_state` 只允许注入 `human.responded` / `task.retried` / `task.archived` / `task.cancelled`；
`completed` 不允许直接回到 `running`（回跳防护）。

需要独立 CLI 时仍可运行 `node apps/mcp-stdio/dist/index.js`；不要把没有执行权限的 JS
文件直接作为客户端的 command。已有 `awm-mcp` 全局链接仍兼容。

“AWM 验证外部 MCP Server”支持 stdio 的 command + args，或 Streamable HTTP URL。
该功能只初始化、枚举并结束验证会话，显示上次验证时间与错误，不执行外部工具或注入任务事件。

桥接进程不碰数据库，只通过 `runtime.json`（0600）握手后连本地控制 API，
桌面应用没启动时返回 `ENGINE_UNAVAILABLE` 而不是挂起。

---

## 七、关键工程决策

完整记录见 [docs/adr/ADR-11-implementation-decisions.md](./docs/adr/ADR-11-implementation-decisions.md)：

1. **事件类型补 2 个**：`task.timeout`（30 分钟等待超时）与 `task.cancelled`（MCP 白名单）。
2. **迁移合法性单点裁决**：`TRANSITION_TABLE` 是唯一权威，XState 只负责推进，一致性由运行时断言 + 单测保证。
3. **渲染层零依赖**（ADR-11）：原生 TS + CSS，不引入 React/Vite，避免新增安装与构建链。
4. **MCP 手写协议**（ADR-12）：只实现 initialize / tools.list / tools.call 三个面。
5. **runtime.json 握手**（ADR-13）：随机端口 + 0600 文件，桥接进程现读。
6. **心跳加进程佐证**（ADR-15）：连续无写入但进程仍在时不判超时，避免误报。
7. **非迁移事件与非法迁移分流**（2026-10-20 审计）：`anomaly` / `tool.detected`
   不推进状态机，落库前懒创建会话行（外键约束）；非法迁移记审计后丢弃，
   引擎内部拒绝非法迁移；控制 API/MCP 返回 `ILLEGAL_TRANSITION`，与 `NOT_FOUND` 分开。
8. **统计下推 SQL**（2026-10-20 审计）：`countActiveByTool` / `countByState`
   用 GROUP BY 聚合，取代「limit 截断后应用层 filter」——后者在会话数超限时会少计。

---

## 八、验证纪律

- **L1（必做）**：`sh scripts/l1-verify.sh`，覆盖 typecheck + 全部单测 + lint，日志写入 `.verify/l1.log`。
- **L2（按需）**：契约测试与集成测试已包含在 `pnpm test` 内。
- **L3（默认禁止）**：UI 实测与 E2E，仅在明确要求或复杂交互改动时执行。
- UI 回归使用合成数据，不启动真实监控或读取用户历史；实际音频输出和平台安装包另行记录验收结果。

看板接口：`GET /api/v1/board?q=&toolId=&group=&cursor=&limit=`，返回各组的 `items`、
完整 `total` 与 `nextCursor`。旧 `/sessions` 数组结构和七态任务枚举保持兼容。
更多修订依据见 [ADR-18](./docs/adr/ADR-18-reliable-monitoring.md)。
