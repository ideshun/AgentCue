# 工程约束与已定决策

## 适用范围

新增依赖、改存储/网络边界、改渲染技术栈、改 MCP 协议面、在 core 中引用具体工具时读取。

## 来源路径 / 符号

- 全局约束：`docs/design/detailed-design.md` 第 1.2 节 C-01~C-08
- 产品边界：同文档 1.1；只感知不代操作（C-01）
- 实现期 ADR：`docs/adr/ADR-11-implementation-decisions.md`
- 核心零工具名测试：`tests/contract/no-tool-name.test.ts`

## 当前实现

必须保持：

- **C-01 本地优先**。运行期默认不出网。扫描只读适配器声明路径，不递归全盘。唯一写入被监控工具的面是用户显式调用的 MCP `update_task_state`。
- **C-05**。`state_events` 只追加；同一 `sessionId` 串行；配置原子写；SQLite 写走事务。
- **C-07**。会话文件读取与审计可关；内容不上传。
- **C-08**。新增运行时依赖须在 `docs/adr/` 记录理由，不引入重型框架。
- **core 零工具名**。`packages/core/src` 不得出现 `claude` / `cursor` / `codex` / `windsurf` / `copilot` / `gemini`（大小写不敏感）。工具名只属于 `packages/adapters`。
- **类型单一事实源**。事件/状态/manifest 以 `@awm/schema` 为准，禁止平行枚举。

已落地的实现决策（不要在未授权时回滚）：

| 编号 | 决策 |
| --- | --- |
| ADR-11 | 渲染层原生 TS + CSS，无 React / Vite / Tailwind |
| ADR-12 | MCP 桥接手写 JSON-RPC over stdio，协议 `2025-06-18`，不引入官方 SDK |
| ADR-13 | 主进程写 `runtime.json`（0600）供桥接进程现读 |
| ADR-14 | `voice_rules` 空库时写入 6 条出厂规则，用户改过不再覆盖 |
| ADR-15 | 心跳丢失需进程已退出才判 timeout；进程仍在则重新计时 |
| ADR-16 | `anomaly` / `tool.detected` 不推进状态机；非法迁移记审计后丢弃 |

`update_task_state` 白名单：`human.responded` / `task.retried` / `task.archived` / `task.cancelled`。`completed` 不能直接回到 `running`。

## 待确认

- 云 TTS（MiMo，ADR-20）必须 `voice.cloudEnabled=true` 且 `voice.cloudApiKey` 非空才 POST；endpoint 留空用官方默认值。默认关闭，失败不回落其他音色。
- 原生 TTS：macOS `say`（白名单中文音色，见 ADR-19）、Windows SAPI、Linux espeak-ng/espeak。
- 本地 Kokoro（ADR-19）/ ZipVoice（ADR-20）：模型仅用户显式下载；GitHub 源国内失败率高，hf-mirror 备选源尚未实现；`pnpm dist` asar 打包模式未经实测。ZipVoice 另需声码器 `vocos_24khz.onnx`、英文词典 `lexicon-en-us.txt`，且每次合成都要参考音频与逐字原文。
- 试听文本统一截 200 字（原 500）——长文本超过 30 秒播放超时上界，属行为变更。
- 许可：禁止复制 GPL-3.0 的 spec-workflow-mcp 代码。

## 更新触发

新增 ADR、改变出网行为、改变状态机权威表、放宽 core 工具名约束、引入新运行时依赖时更新本页。
