# ADR-11 ~ ADR-15 实现期技术决策

> 记录本轮开发相对详细设计文档（v1.0）的偏离与补充。
> 每条包含：背景 → 决策 → 影响 → 回滚成本。

---

## ADR-11 渲染层零依赖实现（替代 React 19 + Tailwind）

**背景**

详细设计 ADR-05 计划 M1 引入 React 19 + Vite + Tailwind。但当前仓库依赖已安装完毕，
新增一套前端构建链需要再执行一次 `pnpm install`（体积与耗时都不小），且渲染层只需要
4 个页面、无复杂局部状态。

**决策**

渲染层用原生 TypeScript 脚本（独立 `tsconfig.renderer.json`，文件内无 import/export，
编译产物是可直接被 `<script src>` 加载的经典脚本）+ 一份手写 CSS（含亮/暗两套变量）。
数据全部走本地控制 API（fetch + SSE）。

**影响**

- 构建链零新增：`tsc -p tsconfig.renderer.json` 即可，无打包器
- 页面切换是全量重绘，数据量在 200 会话内实测无压力（页面结构简单）
- 组件化能力弱于 React；若后续页面复杂化（拖拽看板、虚拟滚动），迁移到 React 的成本集中在
  `views.ts` 与 `app.ts`，业务逻辑（api.ts）可原样复用
- CSP 可收紧到 `script-src 'self'`，无需 `unsafe-eval`

**回滚成本**：中。改 `tsconfig.renderer.json` + 把 views 改写成组件。

---

## ADR-12 MCP 桥接手写协议，不引入官方 SDK

**背景**

官方 TypeScript SDK 已分 v2 包，但桥接层只用到 `initialize` / `tools/list` / `tools/call` 三个方法，
引入 SDK 会带来几十个间接依赖，且 SDK 版本线仍在演进（v1 约 2027-01 停维）。

**决策**

手写 JSON-RPC 2.0 over stdio（按行分隔，非 LSP 的 Content-Length 头），协议版本 `2025-06-18`。
未知方法与非法参数按规范返回 `-32601` / `-32602` / `-32600`。

**影响**

- 桥接包只依赖 `@awm/core`（读握手文件）与 `@awm/schema`（envelope 类型）
- 需要自己维护协议兼容：新增能力（resources / prompts）需补实现
- 已用 `tests/unit/mcp-server.test.ts` 覆盖 8 个协议分支

**回滚成本**：低。`server.ts` 是唯一协议面，换成 SDK 时只改这一层。

---

## ADR-13 进程间握手用 runtime.json（0600）

**背景**

MCP 桥接进程由 AI 客户端拉起，与桌面主进程无父子关系，需要知道控制 API 的端口与 token。
端口用固定值会冲突；写死在配置里则 token 无法轮换。

**决策**

主进程启动时以 `mode 0600` 写入 `<userData>/runtime.json`：`{ apiPort, token, pid, startedAt }`。
桥接进程每次调用现读该文件，因此应用重启后端口变化也能自动跟随。

**影响**

- 无固定端口，避免与用户其它服务冲突（`listen(0)` 由系统分配）
- 同机同用户的其它进程理论上可读该文件（0600 限制了跨用户）
- 文件随应用退出不删除：下次启动直接覆盖，避免启动竞态

**回滚成本**：低。改 `packages/core/src/runtime/paths.ts` 一处。

---

## ADR-14 播报默认规则由首个启动写入数据库

**背景**

规则引擎在无匹配规则时默认 `speak`，会导致 `task.started` 之类的噪声事件也出声。

**决策**

`ensureDefaultVoiceRules()` 仅在 `voice_rules` 为空时写入 6 条出厂规则：
`waiting_human` / `failed` / `timeout` 出声，`completed` 通知，`started` 静音，其余走 `*` 兜底通知。
用户（或 MCP `set_voice_rule`）改过之后不再覆盖。

**影响**

- 首次启动即符合直觉，不需要用户先配规则
- 规则与设置页、MCP 写入共用同一张表，无第二套事实源

---

## ADR-15 心跳丢失判定加「进程已退出」佐证

**背景**

详细设计 FLOW-03 的判定是「连续 3 个周期无信号」。但模型长时间思考时日志文件本来就不写入，
直接判 `heartbeat.lost` 会把正在跑的任务误判成超时。

**决策**

`collectLost()` 命中后，再用 manifest 的 `processNames` 探一次进程：
进程仍在 → 重新计时（不算丢失）；进程已退出 → 才发 `heartbeat.lost`。

**影响**

- 误报显著下降；代价是「进程僵死但未退出」的场景无法识别（M3 可加 CPU 占用探测）
- 判定逻辑在 `apps/desktop/src/main/monitor-service.ts` 的 `tick()`，规则本身仍在 core

---

## ADR-16 全量代码审计修复（2026-10-20）

**背景**

M0~M2 实现完成后做了一次全量静态审计（读 `node_modules` 真实 `.d.ts` 核对第三方 API +
跨文件 import/export 一致性核查），发现 6 个必须修的问题，其中 2 个是编译级错误。

**决策**

按「一次修齐、不挤牙膏」原则全部修复，并各补测试守护：

| # | 问题 | 修法 |
|---|------|------|
| 1 | `store/voice-rules.ts` 导入 schema 未导出的 `VoiceAction`/`VoicePriority`（TS2305） | schema/api.ts 补两个类型导出；core 删本地平行定义改为从 schema 导入 |
| 2 | `anomaly`/`tool.detected` 无边事件被当非法迁移丢弃；且 `state_events.session_id` 外键会让无会话行的事件插入直接失败 | schema 增 `NON_TRANSITION_EVENT_TYPES`；engine-host 拆三条路径（非迁移/合法/非法）；新增 `ensureSessionRow` 懒创建 |
| 3 | 非法迁移无审计（C-07 缺口） | 记 `illegal.transition.rejected` 到 audit_log，不抛错不改状态 |
| 4 | MCP 通知判断只认 `notifications/*` 前缀；`get_timeline` 描述与实际 desc 排序相反 | 改为「无 id 成员即通知」；描述改为「最新在前」 |
| 5 | SSE 广播遇断开客户端 write 抛错，会炸掉整个广播循环 | broadcast/close 加 try/catch，失败即清理死客户端 |
| 6 | electron-builder `files` 显式声明排除 node_modules；缺原生模块 rebuild | files 补 `node_modules/**/*`；`asarUnpack` better-sqlite3；`postinstall: electron-builder install-app-deps` |

附带修正：`listTools` 的应用层统计改为 SQL 聚合（`countActiveByTool`/`countByState`）；
HTTP `tasks/:id/state` 补上与 MCP 共用的白名单校验（原来非法事件会以 500 收场）。

**影响**

- 编译面：store/core/adapters 的跨包类型引用全部对齐单一事实源
- 行为面：异常信号（anomaly）从此可追溯，非法迁移有审计记录可查
- 测试面：store.test 补 3 条、monitor-service.test 补 2 条、adapter-manifest.test 改为参数化覆盖全部 manifest

**回滚成本**：低。全部改动集中在上述文件，无 schema 结构变更（DDL 未动）。
