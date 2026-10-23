# 文档索引

| 文档         | 路径                                                       | 说明                                                                |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| 产品设计方案 | [product/product-design.md](./product/product-design.md)   | 上游需求：定位、用户场景、功能需求 FR-01~29、里程碑                 |
| 详细设计文档 | [design/detailed-design.md](./design/detailed-design.md)   | 开发依据：架构、模块拆解、流程、数据模型、接口、验收标准、TODO 清单 |
| 产品命名方案 | [naming/naming-proposal.md](./naming/naming-proposal.md)   | 命名决策记录，终选 AI Workflow Monitor（AI 工作流监控）             |
| 隐私白皮书   | [privacy.md](./privacy.md)                                 | 本地数据、出网边界、可关闭开关                                      |
| 任务播报接入 | [integrations/task-hooks.md](./integrations/task-hooks.md) | Claude Code、Cursor、Cline、CodeBuddy 官方 Hooks 配置与能力边界     |
| 文档站入口   | [site/index.html](./site/index.html)                       | 静态文档首页                                                        |

## 阅读顺序

1. 先读产品方案，理解「为什么做」与功能边界（FR 编号是后续所有追溯的锚点）。
2. 再读详细设计，按第 7 章目录树对照仓库结构，按第 10 章 TODO 清单领任务。
3. 命名方案在需要对外文案（官网、应用商店、菜单栏 tooltip）时查阅。

## ADR 存放

历史决策见详细设计第 1.3 章（ADR-01~10）。实现期新增决策见
[adr/ADR-11-implementation-decisions.md](./adr/ADR-11-implementation-decisions.md)（ADR-11~16）、
[adr/ADR-17-sse-instead-of-websocket.md](./adr/ADR-17-sse-instead-of-websocket.md)，
[adr/ADR-18-reliable-monitoring.md](./adr/ADR-18-reliable-monitoring.md)，
[adr/ADR-19-local-ai-tts.md](./adr/ADR-19-local-ai-tts.md)，
[adr/ADR-20-tts-voice-quality.md](./adr/ADR-20-tts-voice-quality.md)，
后续决策写入 `adr/ADR-XX-<主题>.md` 并在详细设计文档中登记。
