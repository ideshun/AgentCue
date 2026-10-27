# AI 工具工作流管理软件（AgentCue）详细设计文档

## 0. 文档信息

| 项目 | 内容 |
|------|------|
| 文档名称 | AgentCue 详细设计文档（开发版） |
| 版本 | v1.0 |
| 日期 | 2026-10-19 |
| 上游文档 | 《AI 工具工作流管理软件产品设计方案》v1.0（2026-10-19，下称「产品方案」） |
| 状态 | 待评审，评审通过后可按模块开工编码 |
| 用途 | 直接指导编码：架构、接口契约、目录组织、阶段任务、验收标准、可执行 TODO |

**阅读约定**

1. FR-xx 引用产品方案需求编号（FR-01~FR-29），MOD-x 引用产品方案模块编号，RK-xx 引用风险登记册。本文新增编号：ADR-xx（技术决策）、FLOW-xx（业务流程）、C-xx（约束）、TODO-xx（可执行任务）。
2. 代码块均为类型契约或骨架级别，非最终实现。JS/TS 注释遵循 JSDoc 风格（标签英文、描述中文）。
3. 标注 `[待确认]` 的条目开工前需拍板，其余按本文执行。

---

## 1. 边界与约束

### 1.1 产品边界

| 类别 | 内容 | 来源 |
|------|------|------|
| 本期做 | 工具扫描识别、任务状态机、语音播报、MCP 双轨集成、本地看板 UI、事件存储检索 | 产品方案 6.5 |
| 本期不做 | 多机协同、云端同步、团队账号计费、模型网关路由、任务代操作（远程点按钮）、移动端 | 产品方案 6.5 |
| 只感知不代操作 | AgentCue 不向被监控工具写入任何指令，唯一写入面是用户显式调用的 MCP `update_task_state` | C-01 |

### 1.2 全局工程约束

| 编号 | 约束 | 可验证方式 |
|------|------|-----------|
| C-01 | 本地优先。运行期零出网，唯一例外是用户显式开启的云 TTS 插件（M3，默认关闭）。扫描仅读取适配器声明路径，不递归全盘 | 抓包测试（FR-05） |
| C-02 | 平台范围。MVP 主平台 macOS 14+（arm64 + x64）；Windows 10/11 于 M2 起适配；Linux 于 M4 起社区适配 `[待确认 Q-05]` | 构建产物矩阵 |
| C-03 | 许可合规。spec-workflow-mcp 为 GPL-3.0，只借鉴机制设计，禁止复制其任何代码；magpie 为 MIT，可参考思路，引用需保留版权声明。第三方依赖仅允许 MIT / Apache-2.0 / BSD / ISC | 依赖清单审查 |
| C-04 | 性能预算。状态事实到播报/呈现 P95 ≤ 3 秒（FR-11）；10 工具 + 100 会话并发下空闲 CPU ≤ 2%、常驻内存 ≤ 300 MB；单次全量扫描（10 适配器）≤ 5 秒 | 压测脚本 |
| C-05 | 可靠性。`state_events` 只追加不修改；同一 sessionId 的迁移串行处理；配置写入原子化（临时文件 + rename）；SQLite 全部写操作走事务 | 单测 + 故障注入 |
| C-06 | 可访问性。状态以「颜色 + 图标 + 文字」三重编码；全键盘可达；读屏标签完整（FR-25） | 手工验收清单 |
| C-07 | 隐私。会话文件读取可按工具关闭；审计日志本地留存且可关闭；任何内容不上传 | 设置页开关逐项验证 |
| C-08 | 依赖最小化。新增运行时依赖须在 `docs/adr/` 记录理由；不引入重型框架级依赖 | PR 审查 |

### 1.3 技术决策记录（ADR 摘要）

| 编号 | 决策点 | 选择 | 备选 | 理由 | 状态 |
|------|--------|------|------|------|------|
| ADR-01 | 桌面壳 | Electron 44.x（Node 24.18 / Chromium 152） | Tauri 2 | 单语言栈迭代快、MCP TS SDK 成熟、托盘通知生态齐。Electron 45 于 2026-10-20 转 stable，M0 开工时锁定最新 stable 并冻结 minor 至里程碑结束。M3 复评 Tauri（RK-07） | 已定 |
| ADR-02 | 主语言 | TypeScript（strict），主进程与渲染进程同栈 | Go / Rust | 与适配器生态贡献门槛、MCP SDK 一致 | 已定 |
| ADR-03 | 状态机 | XState v5，每个 sessionId 一个 actor 实例 | 自研 FSM | actor 模型天然支持多会话并发与定时器（心跳、介入倒计时），状态图即文档 | 已定 |
| ADR-04 | 存储 | SQLite（better-sqlite3 + Drizzle ORM）+ 关键配置 JSON 快照 | 纯 JSON 文件 | 事件量大需索引查询；快照保留人可读可备份（吸收 spec-workflow 文件态优点） | 已定 |
| ADR-05 | UI 栈 | React 19 + TypeScript + Tailwind CSS + Zustand | Vue 3 + Element Plus | 产品方案 9.1 推荐方案 A。`[待确认 Q-02]` 若改 Vue，仅影响 `apps/desktop/src/renderer` 与 UI 层，engine/adapter/mcp 层零改动 | 建议采纳 |
| ADR-06 | 实时推送 | 本地 WebSocket hub（绑定 127.0.0.1）；Electron IPC 仅承载窗口/托盘/系统能力 | 纯 IPC 或 SSE | WS 双向（UI 可下发静音等指令），且与 MCP streamable-http 复用同一事件总线，便于调试与后续 Web UI | 已定 |
| ADR-07 | MCP SDK | v2 分包 `@modelcontextprotocol/server` + `@modelcontextprotocol/client`（2026-07-28 spec） | v1 单包 `@modelcontextprotocol/sdk@1.32.x` | v1 维护期约至 2027-01，本项目 M2 恰在其后，新项目应上 v2。M0 PoC 若遇阻塞则降级 v1.32.x 并补 ADR | 建议采纳 |
| ADR-08 | TTS | 平台原生优先（macOS `say`/AVSpeech、Windows SAPI、Linux espeak-ng）+ 可插拔 piper/云 TTS | 单一云 TTS | 零延迟零出网（C-01），失败逐级降级且降级记审计不播报 | 已定 |
| ADR-09 | 打包分发 | electron-builder；macOS 签名 + 公证 | 各平台手包 | 公证为 macOS 分发硬门槛（RK-06） | 已定 |
| ADR-10 | 适配器形态 | 声明式 manifest（YAML，探测/心跳/映射规则）+ 可选 TS 事件提取器（复杂解析） | 纯代码插件 | 新增工具零核心改动（FR-02）；manifest 可热加载、可被校验器验证（M3） | 已定 |

---

## 2. 系统架构与技术选型

### 2.1 进程模型

```
┌──────────────────────────────────────────────────────────────┐
│  AI 客户端（Claude Code / Cursor / Codex …）                    │
│      │ stdio                              │ streamable-http    │
│      ▼                                    ▼                    │
│  [P4] awm-mcp 桥接进程          [P1] 主进程内 MCP Server  │
│      │                                    │                    │
│      └──────── 控制 API（127.0.0.1）───────┘                    │
│                     │                                          │
│  ┌──────────────────┴───────────────────────────────────┐     │
│  │ [P1] Electron 主进程                                   │     │
│  │   事件总线 · 状态机引擎(XState) · 播报编排 · SQLite      │     │
│  │   控制 API(HTTP+WS) · 托盘 · 通知 · 单实例锁            │     │
│  └───┬─────────────────┬──────────────────┬─────────────┘     │
│      │ fork            │ spawn            │ WS + IPC          │
│      ▼                 ▼                  ▼                    │
│  [P2] 扫描子进程    [P3] TTS 后端      [P5] 渲染进程(React UI) │
└──────────────────────────────────────────────────────────────┘
```

| 进程 | 职责 | 生命周期 | 崩溃影响 |
|------|------|----------|----------|
| P1 主进程 | 引擎宿主、托盘、窗口、控制 API、存储 | 常驻，单实例锁 | 全局不可用，托盘可重启 |
| P2 扫描子进程 | 三层探测（配置/进程/API），结果经 IPC 回传 | 按需拉起（首启/手动/定时 6h） | 仅扫描失败，给出修复建议（FR 落地容错引导） |
| P3 TTS 后端 | spawn 平台命令（`say` 等），不进主进程 | 每次播报拉起 | 降级系统通知，不阻塞主链路 |
| P4 MCP stdio 桥接 | `awm-mcp`，由 AI 客户端拉起，连控制 API | 随客户端 | 单客户端受影响；主进程未运行时返回结构化错误 |
| P5 渲染进程 | 仅展示与交互 | 随主窗口 | 重开窗口即可 |

### 2.2 分层与依赖方向

依赖只允许自上而下，跨层引用由 lint 规则（`import/no-restricted-paths`）强制。

| 层 | 内容 | 允许依赖 |
|----|------|----------|
| 展示层 | React UI、托盘、通知 | 应用服务层（经 IPC/WS） |
| 应用服务层 | 看板服务、规则引擎、播报编排、通知中心、设置服务 | 核心引擎层 |
| 核心引擎层 | scanner、statemachine、heartbeat、voice、api、mcp | 适配器层、数据系统层 |
| 适配器层 | registry、loader、内置适配器 | 仅 schema 包 |
| 数据与系统层 | store（SQLite）、fs/进程监控、TTS 后端、transport | 无 |

### 2.3 技术选型锁定

| 层 | 选型 | 版本基线 | 用途说明 |
|----|------|----------|----------|
| 桌面壳 | Electron | 44.x（锁定 minor，M0 定版） | 主进程 Node 24.18 |
| 语言 | TypeScript | 5.x，`strict: true` | 全仓统一 |
| 状态机 | XState | v5.x | 每 session 一个 actor |
| 存储 | better-sqlite3 + Drizzle ORM | 与 Electron ABI 匹配版本 | 同步 API，事务简单 |
| schema | Zod | 3.25+ | 事件、manifest、API、MCP 入参统一校验源 |
| UI | React + Tailwind CSS + Zustand | React 19.x | 见 ADR-05 |
| 实时 | `ws`（Node）+ 浏览器 WebSocket | 8.x | 本地 hub |
| 文件监控 | chokidar | 4.x | 会话文件、适配器目录热加载 |
| 进程探测 | Node `child_process` 调 `ps`/`tasklist` | — | 扫描子进程内执行 |
| MCP | `@modelcontextprotocol/server` + `/client` | 2.x | 见 ADR-07 |
| 测试 | Vitest + Playwright + 契约测试 | — | 分级见 9.3 |
| 打包 | electron-builder | 26.x | mac 签名公证 |
| 工程 | pnpm workspace + ESLint + Prettier | — | monorepo |

### 2.4 事件主链路（架构级时序）

1. 适配器从工具侧取数（会话文件 / 进程事件 / 本地 API / MCP 回调）。
2. 提取器将原始信号映射为标准事件（schema 包校验，不合法打 `anomaly`）。
3. 事件总线按 sessionId 入队，状态机 actor 串行消费。
4. FSM 校验迁移合法性（迁移表 + 回跳防护），写 `state_events` 与 `sessions.current_state`（同一事务）。
5. 迁移结果同步三路：控制 API WS 推送给 UI；播报引擎按规则路由；MCP 查询缓存失效。
6. 播报链路独立降级，任何失败不影响 4、5 步已落库的状态。

---

## 3. 功能模块拆解与优先级

### 3.1 子模块分解

| 子模块 | 所属 | 职责 | 优先级 | 里程碑 | 依赖 | 对应 FR |
|--------|------|------|--------|--------|------|---------|
| SM-1.1 适配器注册表与加载器 | MOD-1 | manifest 校验、热加载、启停单个适配器 | P0 | M0 | schema | FR-02 |
| SM-1.2 三层探测器 | MOD-1 | 配置文件 / 进程可执行 / 运行时 API 探测 | P0 | M1 | SM-1.1 | FR-01/03 |
| SM-1.3 扫描编排器 | MOD-1 | 触发源管理、并发控制、结果合并、忽略清单 | P0 | M1 | SM-1.2 | FR-01/04 |
| SM-2.1 事件归一化 | MOD-2 | 适配器信号 → 标准事件（7 类 + 3 补充） | P0 | M0 | schema | FR-06 |
| SM-2.2 FSM 核心 | MOD-2 | XState 迁移、守卫、审计、时间线 | P0 | M0 | SM-2.1、store | FR-06/07 |
| SM-2.3 心跳与超时 | MOD-2 | 3 周期无信号判 timeout、介入倒计时 30min | P0 | M1 | SM-2.2 | FR-09 |
| SM-2.4 查询服务 | MOD-2 | 待介入队列、检索、导出 | P0 | M1 | store | FR-08/10 |
| SM-3.1 规则引擎 | MOD-3 | scope（工具 × 事件）匹配 action | P0 | M1 | store | FR-11/15 |
| SM-3.2 去抖合并器 | MOD-3 | 30s 去重、5min 同类合并、2s 全局冷却 | P1 | M1 | SM-3.1 | FR-14 |
| SM-3.3 优先级队列 | MOD-3 | 高优可打断、中低排队 | P1 | M1 | SM-3.2 | FR-13 |
| SM-3.4 TTS 抽象层 | MOD-3 | 后端接口、降级链、音色/语速 | P0 | M1 | — | FR-11/12 |
| SM-3.5 多通道联动 | MOD-3 | 托盘闪烁、系统通知、通知中心 | P1 | M1 | — | FR-11 |
| SM-4.1 MCP Server | MOD-4 | 6 工具注册、schema 声明、错误三元组 | P1 | M2 | SM-2.4 | FR-17 |
| SM-4.2 本地控制 API | MOD-4 | HTTP+WS、token 鉴权、限流、审计 | P1 | M2 | core | FR-20 |
| SM-4.3 MCP Client 汇聚 | MOD-4 | 连外部 server、工具枚举、事件注入 | P1 | M2 | SM-4.2 | FR-18/19 |
| SM-4.4 接入配置生成器 | MOD-4 | 多客户端 mcpServers 片段生成 | P1 | M2 | SM-4.1 | FR-16 |
| SM-5.x 看板 UI | MOD-5 | 总览、看板、详情抽屉、通知中心 | P0/P1 | M1/M2 | api | FR-21~25 |
| SM-6.x 设置与规则中心 | MOD-6 | 播报、规则矩阵、隐私、适配器管理 | P1 | M2/M3 | core | FR-26~29 |
| SM-7.1 存储层 | MOD-7 | DDL、迁移、DAO、JSON 快照 | P0 | M0 | — | FR-10 |
| SM-7.2 检索导出 | MOD-7 | 过滤查询、JSON 导出 | P1 | M2 | SM-7.1 | FR-10 |
| SM-8.1 适配器 SDK | MOD-8 | 描述包规范、校验器、示例 | P2 | M3 | schema | FR-02 |

### 3.2 开发顺序（拓扑序）

`schema → store → statemachine(骨架) → scanner(1 适配器) → voice → UI 基础 → 剩余适配器 → 心跳/检索 → MCP → 规则中心 → SDK`

### 3.3 优先级口径

- P0：MVP 阻塞项，M0/M1 必须完成。
- P1：M1 尾部或 M2 完成，影响完整体验但不阻塞核心闭环。
- P2：M3 起，生态扩展。

---

## 4. 核心业务流程

### FLOW-01 扫描识别

1. 触发：首启向导 / 手动点击 / 定时器（默认 6h）/ 适配器变更。
2. 扫描编排器读注册表，过滤「已忽略」与「已禁用」适配器。
3. 拉起扫描子进程，对每个适配器并行执行三层探测（配置存在性 → 进程/版本 → 运行时 API）。
4. 三层结果合并为四态之一：`installed / running / not_installed / unknown`（FR-03）。判定规则：配置存在且进程缺失 = installed；进程命中 = running；配置缺失且进程缺失 = not_installed；探测异常 = unknown。
5. 结果写 `tools` 表（upsert，更新 `last_seen_at`）；新工具发 `tool.detected` 事件（默认静默，11.2）。
6. 异常分支：单适配器探测抛错 → 标记该适配器 degraded，UI 给出「具体文件 + 修复路径」提示，不中断整体扫描。

### FLOW-02 状态事件归一与迁移（主链路）

```
适配器原始信号 → 提取器映射 → schema 校验 → 事件队列(sessionId 分片)
  → FSM actor 串行消费 → 迁移合法性校验 → 落库(state_events + sessions)
  → 三路分发(WS / 播报 / MCP 缓存失效)
```

FSM 草图（契约级）：

```ts
/**
 * 任务状态机定义，每个 sessionId 一个 actor 实例
 * 迁移表与守卫完全对齐产品方案 7.3「状态迁移表」
 */
const taskMachine = setup({
  types: {} as {
    context: TaskContext
    events: StandardEvent
  },
  guards: {
    /** 回跳防护：终态仅允许 archived 或显式 retried */
    canEnterRunning: ({ context }) =>
      !['completed', 'cancelled'].includes(context.state) || context.retryRequested,
  },
}).createMachine({
  id: 'task',
  initial: 'idle',
  states: {
    idle: { on: { 'task.started': { target: 'running', guard: 'canEnterRunning' } } },
    running: {
      on: {
        'task.waiting_human': 'waiting_human',
        'task.failed': 'failed',
        'task.completed': 'completed',
        'heartbeat.lost': 'timeout',
      },
    },
    waiting_human: {
      entry: 'startInterventionTimer', // 默认 30 分钟，超时发 task.timeout
      on: {
        'human.responded': 'running',
        'task.timeout': 'timeout',
      },
    },
    failed: { on: { 'task.retried': 'running', 'task.archived': 'idle' } },
    timeout: { on: { 'task.retried': 'running', 'task.archived': 'idle' } },
    completed: { on: { 'task.archived': 'idle' } }, // 禁止 completed → running
    cancelled: { on: { 'task.archived': 'idle' } },
  },
});
```

约束落地（产品方案 7.3 四条）：

1. 每次迁移写审计五元组（prev、next、trigger、actor、ts）+ reason，进入 `state_events`。
2. waiting_human 进入即启动 30 分钟倒计时 actor，超时迁 timeout 并高优播报。
3. 同 sessionId 事件入队串行；乱序按 `occurredAt` 补正，无法补正写 `anomaly` 事件（仅通知）。
4. `completed → running` 被 guard 拒绝，只允许新建实例或 `task.retried` 显式重试。

### FLOW-03 心跳超时判定

1. 适配器 manifest 声明 `heartbeat.intervalSec` 与 probe 类型（`file_mtime` / `api_ping` / `process_alive`）。
2. 心跳监控器按间隔采样，连续 3 个周期无信号 → 发 `heartbeat.lost`（FR-09）。
3. FSM 将 running / waiting_human 中的会话迁移到 `timeout`，高优播报。
4. 用户可一键「转回 running」（RK-05 误判补救），该操作记审计。

### FLOW-04 语音播报编排

1. 迁移事件进入规则引擎，匹配 `voice_rules`（scope = 事件类型 × 工具，action = mute/notify/speak）。
2. 命中 speak → 去抖合并器（同 session 同类 30s 去重；5min 窗口同工具 ≥3 个 completed 合并；全局冷却 2s）。
3. 优先级队列：高优（waiting_human/failed/timeout）可打断当前播报；completed 不可打断。
4. 文本渲染：模板 + 变量替换（`{tool}` `{title}` `{duration}`），截断 ≤ 40 字。
5. TTS 抽象层 `speak(text, priority, interruptible, voiceProfile)`，后端失败沿降级链（原生 → piper → 仅通知）。
6. 免打扰判定优先于第 2 步：全局静音 / 时段免打扰 / 按工具静音命中时，仅落通知中心；waiting_human 可配「仍要出声」例外。
7. 同步三路：托盘图标闪动、系统通知（含「打开工具」「静音此任务」按钮）、通知中心留存。

### FLOW-05 MCP 外向调用（AI 工具 → AgentCue）

1. 客户端经 stdio 拉起 `awm-mcp`，或直连主进程 streamable-http transport。
2. 请求进入限流器（120 req/min per client，FR-20），超限返回限速错误并记审计。
3. 路由到 6 工具实现，校验入参 schema，查询走 store 或状态机服务。
4. 返回统一 envelope：`{ success, data?, error?, details?, suggestion? }`。`update_task_state` 产生的迁移复用 FLOW-02 落库与播报。

### FLOW-06 MCP 内向汇聚（AgentCue → 外部 MCP）

1. 用户在设置页添加外部 server（stdio / streamable-http），Client 连接并 `listTools`。
2. 工具清单写 `mcp_servers.tools`，进入工具能力画像（标注来源 = 外部）。
3. 外部工具调用产出可识别状态时（含自定义上报工具），注入标准事件走 FLOW-02（FR-19）。
4. 连接失败/超时标注 server 状态 degraded，重试策略：指数退避，最多 3 次后人工重连。

### FLOW-07 首启向导（七步）

欢迎与本地优先说明 → 授权与扫描范围确认（默认最小集）→ 扫描执行（探测层逐项点亮）→ 结果页（工具卡片 + 手动添加 + 忽略）→ 语音测试（选音色、试听、免打扰时段）→ 生成 MCP 接入配置 → 进入主看板。每步可跳过，跳过项在设置页可补。

### FLOW-08 异常与降级

| 异常 | 处理 | 用户可见 |
|------|------|----------|
| 适配器 manifest 非法 | 加载器拒绝并指明字段，其余适配器继续 | 设置页红条 + 修复路径 |
| SQLite 写失败 | 事务回滚，事件留内存重试队列（最多 3 次），仍失败则写本地兜底 JSONL | 通知中心「存储异常」 |
| 控制 API 端口占用 | 递增重试 10 次，仍失败提示端口配置 | 启动报错页 |
| TTS 后端不可用 | 降级链逐级尝试，全部失败走纯通知 | 设置页显示降级状态 |
| WS 断连 | UI 自动重连（指数退避），重连后拉增量 | 顶栏「连接中断」徽标 |

---

## 5. 数据模型与接口设计

### 5.1 本地存储布局

```
~/Library/Application Support/AIWorkflowMonitor/
├─ awm.db              # SQLite 主库
├─ settings.json         # 用户设置（原子写）
├─ runtime.json          # 控制 API 端口 + token（0600 权限，启动时重建）
├─ snapshots/            # 关键配置 JSON 快照（备份与 diff）
├─ adapters/             # 用户导入的第三方适配器（M3）
└─ logs/                 # 运行日志（不含会话内容）
```

Windows 对应 `%APPDATA%/AIWorkflowMonitor`，Linux 对应 `~/.local/share/ai-workflow-monitor`。

### 5.2 SQLite DDL

```sql
-- 工具清单（FR-01/03）
CREATE TABLE tools (
  tool_id          TEXT PRIMARY KEY,          -- 适配器 id，如 claude-code
  name             TEXT NOT NULL,
  adapter_id       TEXT NOT NULL,
  detect_status    TEXT NOT NULL CHECK (detect_status IN ('installed','running','not_installed','unknown')),
  version          TEXT,
  config_path      TEXT,
  executable_path  TEXT,
  ignored          INTEGER NOT NULL DEFAULT 0,
  first_seen_at    TEXT NOT NULL,             -- ISO 8601
  last_seen_at     TEXT NOT NULL
);

-- 会话（1 工具 N 会话）
CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,            -- "{toolId}:{project}:{sessKey}"
  tool_id        TEXT NOT NULL REFERENCES tools(tool_id),
  project        TEXT,
  title          TEXT,
  current_state  TEXT NOT NULL CHECK (current_state IN
    ('idle','running','waiting_human','failed','completed','cancelled','timeout')),
  started_at     TEXT,
  ended_at       TEXT,
  updated_at     TEXT NOT NULL,
  UNIQUE (tool_id, session_id)
);
CREATE INDEX idx_sessions_state ON sessions (current_state, updated_at DESC);

-- 状态事件日志（只追加，FR-06/10）
CREATE TABLE state_events (
  event_id     TEXT PRIMARY KEY,              -- "evt_" + ULID
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  tool_id      TEXT NOT NULL,
  event_type   TEXT NOT NULL,                 -- 7 类 + heartbeat.lost / tool.detected / anomaly
  prev_state   TEXT,
  next_state   TEXT,
  actor        TEXT NOT NULL CHECK (actor IN ('tool','human','system','mcp')),
  reason       TEXT,
  ts           TEXT NOT NULL,
  payload      TEXT                           -- JSON
);
CREATE INDEX idx_events_session ON state_events (session_id, ts);
CREATE INDEX idx_events_type_ts ON state_events (event_type, ts);
CREATE INDEX idx_events_state ON state_events (next_state, ts);

-- 播报规则（FR-11/12/15）
CREATE TABLE voice_rules (
  rule_id     TEXT PRIMARY KEY,
  scope_tool  TEXT,                           -- NULL = 全部工具
  scope_event TEXT NOT NULL,                  -- 事件类型或 '*'
  action      TEXT NOT NULL CHECK (action IN ('mute','notify','speak')),
  template    TEXT,
  priority    TEXT CHECK (priority IN ('low','mid','high')),
  updated_at  TEXT NOT NULL
);

-- 外部 MCP Server（FR-18）
CREATE TABLE mcp_servers (
  server_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  transport  TEXT NOT NULL CHECK (transport IN ('stdio','streamable-http')),
  command    TEXT,                            -- stdio 用
  args       TEXT,
  url        TEXT,                            -- http 用
  status     TEXT NOT NULL DEFAULT 'disconnected',
  tools      TEXT                             -- JSON 数组
);

-- 审计（FR-20 / C-07）
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  result  TEXT
);
```

### 5.3 标准事件 Schema

```ts
/** 标准事件，schemaVersion 用于兼容演进 */
interface StandardEvent {
  eventId: string                 // "evt_" + ULID
  sessionId: string               // "{toolId}:{project}:{sessKey}"
  toolId: string
  eventType: EventType
  occurredAt: string              // ISO 8601
  actor: 'tool' | 'human' | 'system' | 'mcp'
  payload: {
    taskTitle?: string
    reason?: string
    heartbeatSeq?: number
    [k: string]: unknown
  }
  schemaVersion: 1
}

type EventType =
  | 'task.started' | 'task.waiting_human' | 'human.responded'
  | 'task.failed' | 'task.completed' | 'task.retried' | 'task.archived'
  | 'heartbeat.lost' | 'tool.detected' | 'anomaly'
```

同一 Zod 定义同时服务：适配器输出校验、WS 消息体、MCP 入参、测试夹具。禁止任何模块自造平行类型。

### 5.4 适配器 manifest Schema

```yaml
# resources/adapters/claude-code.manifest.yaml（契约示例，字段由 Zod 校验）
id: claude-code                       # 必填，唯一
name: Claude Code
detect:
  configPaths:
    - mac: "~/.claude/settings.json"
      win: "%USERPROFILE%/.claude/settings.json"
      envOverride: ["CLAUDE_CONFIG_DIR"]
  processNames: ["claude"]
  apis: []                            # 如 { host: "127.0.0.1", port: 23001, probePath: "/health" }
sessionSource:
  type: jsonl                         # jsonl | dir-watch | api | process-event
  pathPattern: "~/.claude/projects/**/*.jsonl"
eventMapping:
  waiting_human: { match: "permission_request", reason: "tool_approval" }
  completed:     { match: "result", ok: true }
  failed:        { match: "result", ok: false }
heartbeat: { intervalSec: 30, probe: "file_mtime" }
mcp: { clientConfigFormat: "claude-code" }
extractor: ./extract.ts               # 可选，复杂解析走 TS 提取器
```

核心约束：`packages/core` 不得出现任何具体工具名字符串（用契约测试断言）。

### 5.5 本地控制 API（127.0.0.1 + Bearer token）

| 方法 | 路径 | 入参 | 返回 | 用途 |
|------|------|------|------|------|
| GET | `/api/v1/health` | — | `{ ok, version, uptime }` | 探活 |
| GET | `/api/v1/tools` | — | `ToolSummary[]` | 总览页 / MCP list_tools |
| GET | `/api/v1/sessions` | `?state&toolId&limit` | `SessionSummary[]` | 看板 / MCP list_sessions |
| GET | `/api/v1/sessions/:id` | — | 会话详情 + 近 5 条迁移 | 详情抽屉 / get_task_status |
| GET | `/api/v1/sessions/:id/timeline` | `?limit` | 迁移链数组 | 时间线 / get_timeline |
| POST | `/api/v1/sessions/:id/events` | 标准事件 | 迁移结果 | MCP 注入（FR-19） |
| POST | `/api/v1/tasks/:id/state` | `{ event, reason? }` | 迁移结果 | update_task_state |
| POST | `/api/v1/scan` | — | 扫描任务 id | 手动扫描 |
| GET | `/api/v1/events` | `?type&toolId&from&to` | 事件数组 | 检索导出 |
| GET/PUT | `/api/v1/settings` | 设置对象 | 设置对象 | 设置页 |
| POST | `/api/v1/voice/test` | `{ text, voiceProfile }` | `{ ok }` | 试听 |
| WS | `/api/v1/stream` | 订阅消息 | 事件推送 | UI 实时同步 |

安全基线（FR-20）：仅绑定 127.0.0.1；token 每次启动随机生成写 `runtime.json`（0600）；限流 120 req/min per token；全部调用记 `audit_log`；payload 中可能含敏感内容的字段（会话文件路径外的内容）不入审计。

WS 消息封套：`{ type: 'state.transition' | 'tools.updated' | 'notify' | 'heartbeat', data, ts }`。

### 5.6 Electron IPC 通道（仅系统能力）

| 通道 | 方向 | 用途 |
|------|------|------|
| `tray:setState` | main → renderer 事件 | 菜单栏圆点状态（绿/红 + 数量） |
| `notification:show` | main 调用 | 系统通知 + 动作按钮回调 |
| `window:openTask` | renderer → main | 通知点击直达任务详情 |
| `shell:openExternal` | renderer → main | 「在工具中打开」跳转 |
| `dialog:pickPath` | renderer → main | 手动添加工具选路径 |
| `app:relaunch` | renderer → main | 适配器变更后重启 |

### 5.7 MCP 工具契约（6 个，FR-17）

| 工具名 | 入参 | 返回 | 备注 |
|--------|------|------|------|
| `list_tools` | `{}` | 工具清单（含状态、版本、会话数） | 对应总览页 |
| `list_sessions` | `{ state?, toolId?, limit? }` | 会话摘要数组 | 默认 limit 50 |
| `get_task_status` | `{ sessionId }` | 当前态 + 最近 5 条迁移 | FR-17 验收点 |
| `update_task_state` | `{ sessionId, event: 'human.responded'\|'task.retried'\|'task.archived'\|'task.cancelled', reason? }` | 迁移结果 | 白名单事件，拒绝非法迁移 |
| `set_voice_rule` | `{ scopeTool?, scopeEvent, action, template?, priority? }` | 规则对象 | 幂等 upsert |
| `get_timeline` | `{ sessionId, limit? }` | 迁移链 | 可复制 JSON |

统一错误三元组：`{ success: false, error: { code, message }, details?, suggestion? }`，`code` 枚举：`NOT_FOUND / INVALID_PARAM / ILLEGAL_TRANSITION / RATE_LIMITED / ENGINE_UNAVAILABLE`。

### 5.8 settings.json 结构

```jsonc
{
  "schemaVersion": 1,
  "scan":     { "autoIntervalHours": 6, "ignoredToolIds": [] },
  "voice":    { "enabled": true, "volume": 0.8, "rate": 1.0, "voiceProfile": "system-default", "backend": "native" },
  "quiet":    { "globalMute": false, "ranges": [{ "from": "22:30", "to": "08:30" }], "waitingHumanOverride": true },
  "privacy":  { "sessionFileRead": true, "auditLog": true, "scanScope": "minimal" },
  "mcp":      { "serverEnabled": true, "transport": ["stdio", "streamable-http"], "port": 47831 }
}
```

### 5.9 兼容与版本演进

事件 `schemaVersion` 与 `settings.schemaVersion` 独立演进；store 启动时执行幂等迁移；跨大版本迁移前自动写 `snapshots/` 快照。MCP 工具签名只增不改，破坏性变更走新工具名（如 `get_task_status_v2`）。

---

## 6. 关键页面与交互结构

### 6.1 信息架构与路由

实现以源码为准（hash 路由，见 `apps/desktop/src/renderer/app.ts`）：

| 路由 | 页面 | 入口 |
|------|------|------|
| `#/overview` | 工具总览（默认） | 主窗口、托盘「打开」、Cmd/Ctrl+1 |
| `#/board` | 任务看板 | 总览点击、Cmd/Ctrl+2、`/` 聚焦搜索 |
| `#/notifications` | 通知中心 | 侧栏、Cmd/Ctrl+3；侧栏角标显示未读数 |
| `#/integrations` | 播报接入（按工具分组 Hooks / MCP） | 侧栏、Cmd/Ctrl+4 |
| `#/adapters` | 工具与扩展（适配器） | 侧栏、Cmd/Ctrl+5 |
| `#/settings` | 设置（吸顶分区导航：语音 / 免打扰 / 播报规则 / 扫描与隐私 / 外部服务） | 侧栏、Cmd/Ctrl+6、托盘 |
| 任务详情抽屉 | 时间线 | 看板/总览/通知的卡片点击 |

首启七步向导（`/wizard`）未实现；快捷键见 `app.ts` 的 keydown 绑定。

### 6.2 页面规格

**页面 1 工具总览（FR-21）**

```
┌─────────────────────────────────────────────────┐
│ 顶栏: 待介入 N │ 执行中 M │ 今日完成 K │ [扫描] [静音] │
├─────────────────────────────────────────────────┤
│ 工具卡片网格                                     │
│  ┌────────┐ ┌────────┐ ┌────────┐              │
│  │图标    │ │图标    │ │  …     │              │
│  │名称    │ │名称    │ │        │              │
│  │v 版本  │ │v 版本  │ │        │              │
│  │● 运行中│ │○ 已安装│ │        │              │
│  │会话 3  │ │会话 0  │ │        │              │
│  │最近事件│ │最近事件│ │        │              │
│  └────────┘ └────────┘ └────────┘              │
│ [已忽略分组（可恢复）]                            │
└─────────────────────────────────────────────────┘
```

- 组件：`OverviewStatBar`、`ToolCard`、`IgnoredGroup`、`EmptyGuide`（空态含「重新扫描」+「手动添加」）、`ScanProgressLayer`（探测层逐项点亮）。
- 交互：点卡片进入 `/board?toolId=`；卡片右上菜单含「静音此工具」「忽略」「查看配置路径」。

**页面 2 会话看板（FR-22/08）**

- 视图切换：看板（四列：待介入 / 执行中 / 失败 / 完成）| 列表（时间倒序）。cancelled/timeout 归入失败列，角标区分。
- 待介入列置顶红框，按等待时长降序，卡上主按钮「在工具中打开」。
- 卡片要素：标题、来源工具徽标、状态徽标、进入该态时长（实时刷新）、摘要行。
- 拖拽归档：拖到「完成」列触发 `task.archived`，10s 内可撤销（toast + 撤销按钮）。
- 实现对齐（以源码为准）：归档/重试以按钮实现，无拖拽、无撤销、无列表双视图；四状态列之外另有第五列「历史 · 状态未知」（仅历史索引卡片）。FR-24 的级别筛选与未读角标已实现。

**页面 3 任务详情抽屉（FR-23/07）**

- 上部：标题、来源、项目路径、当前状态、开始时间。
- 中部：垂直时间线，节点 = 迁移（prev → next、触发、actor、原因、时间戳），支持整链复制。
- 下部：错误摘要（failed/timeout 时展示 payload.reason）、快捷操作（重试引导 / 复制事件 JSON / 静音此任务 / 一键转回 running）。

**页面 4 通知中心（FR-24）**

- 列表：时间倒序，级别筛选（高/中/低/静默记录），已读/未读分组，点击直达详情。

**页面 5 设置（FR-26~29）**

- `voice`：音量、语速、音色下拉、TTS 后端选择、试听按钮、模板编辑（含变量提示）。
- `rules`：左侧事件类型 × 工具矩阵，三档单选（静音 / 仅通知 / 播报）；右侧试听与优先级说明。
- `privacy`：扫描范围、会话文件读取、审计日志三开关，每项带说明文案（C-07）。
- `adapters`：已启用适配器列表、单个禁用、manifest 校验错误展示、导入第三方（M3）。
- `mcp`：Server 开关与端口、接入配置生成器（客户端下拉 → 配置片段 + 一键复制）、外部 Server 增删改与连接状态。

### 6.3 设计系统约定

| 约定 | 规格 |
|------|------|
| 状态徽标 | 橙=待介入、蓝=执行中、绿=完成、红=失败；四色四图标全局统一（10.4） |
| 四态 | 每页实现空态 / 加载骨架 / 错误（含修复建议）/ 无权限 |
| 反馈 | 操作即 toast 或内联结果；播报触发时托盘图标闪动 |
| 可逆 | 忽略工具可随时恢复（再点「恢复扫描」）；改规则即时生效可改回。10s 撤销机制未实现 |
| 可达性 | 焦点环可见、Tab 序合理、状态不单靠颜色（C-06） |

---

## 7. 项目目录与代码组织

### 7.1 仓库形态

pnpm workspace 单仓。仓库名 `ai-workflow-monitor`，主分支 `main`，功能分支 `feat/<模块>-<简述>`。

### 7.2 目录树

```
ai-workflow-monitor/
├─ package.json                 # workspace 根，scripts: dev/build/test/lint
├─ pnpm-workspace.yaml
├─ tsconfig.base.json           # strict 全仓共享
├─ eslint.config.mjs            # 含 import 边界规则
├─ docs/
│  ├─ product/                  # 产品方案（上游）
│  ├─ design/                   # 本文档
│  └─ adr/                      # ADR-01~10 及后续
├─ apps/
│  ├─ desktop/
│  │  ├─ src/main/              # [P1] Electron 主进程
│  │  │  ├─ index.ts            # 入口：单实例锁、生命周期
│  │  │  ├─ engine-host.ts      # 装载 packages/core
│  │  │  ├─ tray.ts / windows.ts / notifications.ts
│  │  │  ├─ scanner-worker.ts   # [P2] fork 目标
│  │  │  └─ ipc/                # IPC handler 注册（5.6）
│  │  ├─ src/preload/           # contextBridge 暴露白名单 API
│  │  ├─ src/renderer/          # [P5] React UI
│  │  │  ├─ main.tsx
│  │  │  ├─ app/                # 路由、布局、providers
│  │  │  ├─ pages/              # overview / board / notifications / settings / wizard
│  │  │  ├─ components/         # ToolCard / StatusBadge / Timeline / RuleMatrix …
│  │  │  ├─ stores/             # Zustand（工具、会话、设置）
│  │  │  └─ styles/
│  │  └─ electron-builder.yml
│  └─ mcp-stdio/
│     └─ src/index.ts           # [P4] awm-mcp 桥接入口，连控制 API
├─ packages/
│  ├─ schema/                   # Zod + TS 类型（事件、manifest、API、MCP）唯一事实源
│  ├─ store/                    # Drizzle schema、migrations、DAO
│  ├─ core/
│  │  ├─ bus/                   # 事件总线（sessionId 分片队列）
│  │  ├─ scanner/               # 编排器 + 三层探测器
│  │  ├─ statemachine/          # XState 定义、actor 池、迁移服务
│  │  ├─ heartbeat/             # 心跳监控与超时判定
│  │  ├─ voice/                 # 规则引擎、去抖合并、队列、tts/ 后端适配
│  │  ├─ api/                   # 控制 API（HTTP + WS）、限流、鉴权
│  │  └─ mcp/                   # MCP Server 6 工具实现
│  └─ adapters/
│     ├─ registry.ts / loader.ts # 热加载 + Zod 校验
│     ├─ claude-code/           # manifest.yaml + extract.ts
│     ├─ cursor/
│     └─ codex-cli/
├─ tests/
│  ├─ unit/  ├─ contract/       # 适配器契约测试、核心零工具名断言
│  ├─ integration/              # 引擎 + store 链路
│  └─ e2e/                      # Playwright 冒烟
└─ scripts/                     # 构建辅助、压测、事件回放
```

### 7.3 代码规范

1. TS `strict`，禁止 `any`（必要处 `unknown` + 收窄）。
2. JS/TS 说明性注释一律 JSDoc 风格，标签（`@param` `@returns` `@throws`）英文，描述中文；简单自解释代码不强加注释。
3. 命名：文件 kebab-case，类型/类 PascalCase，函数变量 camelCase，事件类型 `domain.action` 点分小写。
4. 禁止提交：未使用变量、注释掉的死代码、调试用 `console.log`（日志走统一 logger）。
5. 错误不静默吞：抛错或返回必须含上下文（操作 + 参数）；前端网络请求必须有失败兜底 UI。
6. 引用路径用包名（`@awm/schema`），禁止跨包深相对路径。
7. 小步修改，不引入新范式与非必要依赖（C-08）。

### 7.4 测试组织

单测与源码同层（`*.test.ts`）或集中 `tests/unit`；契约测试放 `tests/contract`，每个适配器至少 1 个 fixture 目录（样本会话文件 + 期望事件序列）。

### 7.5 构建产物

| 平台 | 产物 | 备注 |
|------|------|------|
| macOS | .dmg + .app（arm64/x64） | 签名 + 公证（M4） |
| Windows | .exe (NSIS) | M2 起 |
| Linux | AppImage | M4 起 |

---

## 8. 开发阶段划分与里程碑

### 8.1 阶段总览（对齐产品方案 12.1，工程化细化）

| 阶段 | 周期 | 主题 | 工程交付物 | 退出标准（门禁） |
|------|------|------|-----------|------------------|
| M0 技术验证 | 2 周 | 最小证据链 | workspace 脚手架、schema/store/FSM 骨架、claude-code 单适配器、say 播报 1 条 | 端到端演示通过；事件 P95 ≤ 3s；L1 全绿 |
| M1 MVP | 5 周 | 三工具闭环 | 3 适配器、7 态 FSM、心跳、播报 v1、总览 + 看板、事件存储检索 | 5 名用户试用；关键漏报率实测 ≤ 5%；性能预算达标（C-04） |
| M2 MCP 完整 | 4 周 | 双轨 MCP | MCP Server 6 工具、Client 汇聚、配置生成、适配器至 6 个、详情时间线完善 | 任一主流 AI 工具可经 MCP 查询与更新任务状态 |
| M3 规则与生态 | 4 周 | 可定制可扩展 | 规则中心、模板变量、适配器 SDK + 校验器、事件导出、通知操作按钮 | 第三方按 SDK 产出 1 个可用适配器 |
| M4 硬化增长 | 持续 | 质量分发 | 签名公证包、性能优化（10 工具 100 会话）、隐私白皮书、文档站 | 周活留存 ≥ 35% |

### 8.2 M0 任务（2 周）

| 周 | 任务 | 产出 | 验证 |
|----|------|------|------|
| W1 | T-M0-01 pnpm workspace + Electron 空壳 + 托盘 + 单实例锁 | 可运行空应用 | `pnpm build` 通过 |
| W1 | T-M0-02 schema 包（事件/manifest Zod）+ store 包（DDL + 迁移） | 类型与建库 | 单测绿 |
| W2 | T-M0-03 FSM 骨架（7 态迁移表 + 回跳守卫） | 状态机可单测 | 迁移矩阵单测 100% 分支 |
| W2 | T-M0-04 claude-code 适配器（config 探测 + JSONL 单事件） | 识别 + 1 类事件 | 契约测试绿 |
| W2 | T-M0-05 播报最短链（规则直通 → say） | 1 条语音 | 手动演示 ≤ 3s |

### 8.3 M1 任务分解（5 周）

| 周 | 任务 |
|----|------|
| W1 | store 完整 DAO；扫描子进程 + 三层探测器；忽略清单 |
| W2 | cursor + codex-cli 适配器；事件归一化全量；心跳监控（FR-09） |
| W3 | FSM 全量约束（倒计时、串行、anomaly）；查询服务（待介入队列、检索） |
| W4 | 播报引擎 v1（规则、去抖合并、优先级队列、TTS 抽象、免打扰）；多通道联动 |
| W5 | UI：工具总览 + 会话看板 + 详情抽屉（简版）；事件导出；5 人试用准备 |

### 8.4 M2~M4 任务要点

- M2：MCP Server 6 工具 + 控制 API 完整（限流/审计/鉴权）；MCP Client 汇聚；配置生成器；适配器扩至 6（Gemini CLI、Windsurf、Continue 等按用户调研定）；Windows TTS 与路径适配。
- M3：规则矩阵 UI、用户模板、适配器 SDK + `adapter-validator` CLI、事件导出 UI、通知操作按钮、云 TTS 插件（显式开启）。
- M4：签名公证流水线、10 工具 × 100 会话压测调优、隐私白皮书、文档站、Tauri 迁移复评（RK-07）。

### 8.5 工程化基线

| 项 | 约定 |
|----|------|
| 分支 | `main` 受保护，PR 合并，功能分支 `feat/<模块>-<简述>` |
| 提交 | 不自动 commit/push；提交信息中文祈使句，首行 ≤ 50 字符 |
| CI 必跑 | `tsc --noEmit` + `eslint` + `vitest run`（即 L1，见 9.3） |
| 发版 | 里程碑 tag `m0-poc / m1-beta / …`，M4 起 semver |
| 环境 | Node 用 nvm 管理（v22+），包管理 pnpm，registry 经 nrm |

### 8.6 风险的工程应对（RK 映射）

| 风险 | 工程措施 | 落点 |
|------|----------|------|
| RK-01 适配器失效 | manifest 热加载 + 契约测试 + 版本探测兜底；核心零工具名 | SM-1.1 / tests/contract |
| RK-02 状态误报 | 事件映射保守优先（waiting_human 除外）；误报样本回流 fixture | SM-2.1 |
| RK-03 播报打扰 | 默认克制策略 + 首启免打扰 + 一键静音 | SM-3.x |
| RK-04 隐私担忧 | C-01/C-07 + 隐私白皮书 | 全局 |
| RK-05 心跳误判 | 3 周期确认 + 白名单豁免 + 一键转回 running | SM-2.3 |
| RK-06 签名公证 | M0 即提申请（依赖清单 12.3），未就绪出内测包 | 发布流水线 |
| RK-07 Electron 内存 | 扫描独立子进程；M3 复评 Tauri | 进程模型 2.1 |
| RK-08 范围蔓延 | 边界表 1.1 写死；新诉求进后续版本池走变更评估 | 流程 |

---

## 9. 验收标准

### 9.1 完成定义（DoD）

一个模块「完成」须同时满足：

1. 代码合入 main，`tsc --noEmit` / `eslint` / 相关单测全绿（L1）。
2. 对应 FR 的验收标准（产品方案 Given/When/Then）有自动化测试或明确手工验收记录。
3. 无未使用变量、死代码、调试日志（7.3）。
4. 错误路径有兜底 UI 与含上下文的错误信息。
5. 涉及 UI 的，四态（空/加载/错误/无权限）齐备且键盘可达。

### 9.2 测试分级（对应验证纪律）

| 级别 | 内容 | 时机 |
|------|------|------|
| L1 必做 | `tsc --noEmit`、`eslint`、`vitest`（单测 + 契约）、控制 API 用 curl 冒烟 | 每次提交 |
| L2 按需 | 全量测试套件、多模块联调脚本 | 里程碑门禁、发布前 |
| L3 限用 | Playwright UI 冒烟、截图 | 仅 M1/M2/M3 门禁各 ≤ 1 轮；复杂交互（拖拽归档、向导、规则矩阵）走 L3 白名单 |

### 9.3 FR → 测试映射（关键项）

| FR | 验收要点 | 测试类型 | 测试 ID |
|----|----------|----------|---------|
| FR-01 | 装 3 工具扫出 3 条 | 契约 | CT-SCAN-01 |
| FR-02 | 新增适配器不改核心 | 契约 + 静态断言（core 无工具名） | CT-ADP-01 |
| FR-03 | 四态互斥正确 | 单测 | UT-SCAN-03 |
| FR-04 | 忽略后重扫不出现 | 集成 | IT-SCAN-04 |
| FR-05 | 打包后抓包无出网 | 手工 + 脚本 | SEC-01 |
| FR-06 | 双工具同事件归一 | 单测 | UT-EVT-06 |
| FR-07 | 迁移链完整有序 | 集成 | IT-FSM-07 |
| FR-08 | 待介入排序置顶 | 集成 | IT-Q-08 |
| FR-09 | 90s 无信号判超时 | 单测（假时钟） | UT-HB-09 |
| FR-10 | 检索导出正确 | 集成 | IT-QUERY-10 |
| FR-11 | 3 秒内出声 | 集成 + 手工计时 | IT-VOICE-11 |
| FR-12 | 变量替换正确 | 单测 | UT-TPL-12 |
| FR-13 | 高优打断中优 | 单测 | UT-QUEUE-13 |
| FR-14 | 30s 去重、N 合并 | 单测（假时钟） | UT-DEBOUNCE-14 |
| FR-15 | 免打扰时段仅通知 | 单测 | UT-QUIET-15 |
| FR-16 | 配置粘贴即生效 | 手工（按客户端各 1 次） | MC-16 |
| FR-17 | 6 工具 schema 校验 | 契约 | CT-MCP-17 |
| FR-18 | 枚举外部工具成功 | 集成 | IT-MCP-18 |
| FR-19 | 外部事件触发迁移 | 集成 | IT-MCP-19 |
| FR-20 | 限速与审计生效 | 单测 + 压测 | SEC-20 |
| FR-21~25 | 四态 + 可达性 | L3 冒烟 + 手工清单 | E2E-UI-21 |
| FR-26~29 | 规则生效可逆 | 集成 + 手工 | IT-SET-26 |

### 9.4 非功能验收

| 指标 | 目标 | 测量方法 |
|------|------|----------|
| 事件时延 | P95 ≤ 3s（事实 → 播报/呈现） | 埋点打点 + `scripts/latency-report` |
| 扫描耗时 | 10 适配器 ≤ 5s | 扫描计时日志 |
| 空闲资源 | CPU ≤ 2%，内存 ≤ 300MB | 活动监视器 10 分钟采样 |
| 关键漏报率 | ≤ 2%（M1 试用期放宽 ≤ 5%） | 试用用户日志回访 |
| 播报打扰度 | 周静音率 ≤ 15% | 设置页行为埋点（仅计数） |
| 隐私 | 零出网（云 TTS 显式开启除外） | 抓包 |

---

## 10. 可执行 TODO 清单

格式：`TODO-编号 [里程碑] [优先级] 模块` 描述。完成判定对应 9.1 DoD。

| 编号 | 里程碑 | 优先级 | 模块 | 任务描述 | 完成判定 |
|------|--------|--------|------|----------|----------|
| TODO-01 | M0 | P0 | 工程 | 搭建 pnpm workspace、tsconfig strict、ESLint 边界规则、CI（L1） | `pnpm build && pnpm test` 绿 |
| TODO-02 | M0 | P0 | schema | 定义 StandardEvent / AdapterManifest / API 类型的 Zod schema 与导出类型 | 单测覆盖合法/非法样例 |
| TODO-03 | M0 | P0 | store | 实现 DDL、Drizzle 迁移、5 张表 DAO、JSON 快照写入 | DAO 单测绿 |
| TODO-04 | M0 | P0 | statemachine | 实现 7 态 XState 定义、迁移守卫、审计写入、actor 池 | 迁移矩阵单测全分支 |
| TODO-05 | M0 | P0 | adapters | 适配器 loader（Zod 校验、热加载）+ claude-code manifest | 契约测试 CT-ADP-01 |
| TODO-06 | M0 | P0 | scanner | 配置文件探测（含 envOverride 与平台变体） | CT-SCAN-01 |
| TODO-07 | M0 | P0 | adapters | claude-code JSONL 提取器（waiting_human/completed/failed 三类映射） | fixture 事件序列断言 |
| TODO-08 | M0 | P0 | voice | 播报最短链：规则直通 → macOS say，验证 ≤ 3s | 手动计时记录 |
| TODO-09 | M0 | P0 | desktop | Electron 壳：单实例锁、托盘圆点、主窗口骨架 | 手工冒烟 |
| TODO-10 | M1 | P0 | scanner | 进程/可执行探测 + 运行时 API 探测；四态合并逻辑 | UT-SCAN-03 |
| TODO-11 | M1 | P0 | scanner | 扫描编排器：触发源、并发、忽略清单（FR-04） | IT-SCAN-04 |
| TODO-12 | M1 | P0 | adapters | cursor、codex-cli 适配器（manifest + 提取器） | 契约测试各 1 套 fixture |
| TODO-13 | M1 | P0 | statemachine | 介入倒计时 30min、乱序补正、anomaly、串行队列 | 假时钟单测 |
| TODO-14 | M1 | P0 | heartbeat | 3 周期超时判定 + 一键转回 running（RK-05） | UT-HB-09 |
| TODO-15 | M1 | P0 | core | 查询服务：待介入队列、按工具/状态/时间检索 | IT-Q-08 / IT-QUERY-10 |
| TODO-16 | M1 | P1 | voice | 规则引擎 + 去抖合并 + 优先级队列 + 免打扰（FR-12~15） | UT-TPL/QUEUE/DEBOUNCE/QUIET |
| TODO-17 | M1 | P1 | voice | TTS 抽象层与降级链（native → piper → 通知） | 故障注入单测 |
| TODO-18 | M1 | P1 | voice | 多通道联动：托盘闪动、系统通知按钮、通知中心 | 手工清单 |
| TODO-19 | M1 | P0 | desktop | UI：工具总览（含空态、扫描进度）（FR-21） | E2E-UI-21 冒烟 |
| TODO-20 | M1 | P0 | desktop | UI：会话看板四列 + 列表双视图 + 拖拽归档（FR-22） | L3 白名单 1 轮 |
| TODO-21 | M1 | P1 | desktop | UI：任务详情抽屉 + 时间线（FR-23/07） | 手工验收 |
| TODO-22 | M2 | P1 | api | 控制 API 完整：鉴权、限流、审计、WS 推送 | SEC-20 |
| TODO-23 | M2 | P1 | mcp | MCP Server 6 工具 + 错误三元组 + stdio/http 双 transport | CT-MCP-17 |
| TODO-24 | M2 | P1 | mcp | MCP Client 汇聚 + 事件注入（FR-18/19） | IT-MCP-18/19 |
| TODO-25 | M2 | P1 | desktop | 接入配置生成器（多客户端片段 + 复制）（FR-16） | MC-16 手工 |
| TODO-26 | M2 | P1 | adapters | 适配器扩至 6 个（名单按 M1 用户调研定） | 契约测试各 1 套 |
| TODO-27 | M2 | P1 | desktop | 通知中心 + 设置页骨架（FR-24/26） | 手工验收 |
| TODO-28 | M2 | P1 | voice | Windows SAPI 后端 + Windows 路径适配（C-02） | Windows 手工冒烟 |
| TODO-29 | M3 | P2 | adapters | 适配器 SDK 规范 + `adapter-validator` CLI | 第三方样例适配器通过校验 |
| TODO-30 | M3 | P1 | desktop | 规则矩阵 UI、用户模板、事件导出（FR-27/10） | IT-SET-26 |
| TODO-31 | M3 | P2 | voice | 云 TTS 插件（显式开启 + 出网明示） | 合规检查清单 |
| TODO-32 | M4 | P1 | 发布 | 签名公证流水线、安装包矩阵 | 三平台安装通过 |
| TODO-33 | M4 | P1 | 性能 | 10 工具 100 会话压测与调优（C-04） | latency-report 达标 |
| TODO-34 | M4 | P2 | 文档 | 隐私白皮书 + 文档站 | 评审通过 |

---

## 11. 待确认问题与假设

### 11.1 待确认（开工前拍板）

| 编号 | 问题 | 本文默认 | 待决人 |
|------|------|----------|--------|
| Q-01 | 产品正式命名与商标（承接产品方案 Q-01） | 已定：AgentCue，见命名方案 v1.2；商标检索（TODO-N01）待完成 | 业务方 |
| Q-02 | UI 栈 React 还是 Vue（承接产品方案 Q-02） | React 19 + Tailwind（ADR-05），改动面仅渲染层 | 技术负责人 |
| Q-03 | 云 TTS 是否开放（承接产品方案 Q-03） | M3 做显式开启插件，默认全离线 | 产品 + 合规 |
| Q-04 | 任务代操作是否进后续路线（承接产品方案 Q-04） | 列后续版本池，本期不做 | 业务方 |
| Q-05 | 平台优先级 Windows / Linux（本文 C-02 细化） | macOS 先行，Windows M2，Linux M4 | 技术负责人 |
| Q-06 | MCP SDK 上 v2 还是 v1（ADR-07） | v2 分包，M0 PoC 验证，阻塞则降级 v1.32.x | 技术负责人 |
| Q-07 | 仓库托管与开源策略（影响 C-03 合规表述） | 内部私有仓起步 | 业务方 |

### 11.2 本文假设

1. 假设开发机为 macOS（用户当前环境），M0 仅需 macOS 可演示。
2. 假设用户已有 Claude Code、Cursor、Codex CLI 中至少 2 个可用于 M1 试用样本。
3. 假设产品方案 6.3 用户画像成立，M1 第 2 周完成 5 人访谈校准（依赖清单 12.3）。
4. 假设 macOS 签名公证账号在 M4 前 1 个月就绪（RK-06），否则 M4 仅发内测包。

---

> 本文档为开发实施依据。评审确认后按第 10 章 TODO 顺序开工；未列入 TODO 的新诉求走变更评估（RK-08），不直接进开发。
