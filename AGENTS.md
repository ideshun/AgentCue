# 项目 AI 工作入口

## 工作边界

确认仓库根目录包含项目 `package.json` 和 Git 元数据，并查看已有改动；仓库目录可叫 `AgentCue` 或 `ai-workflow-monitor`。区分只读、计划、实施；只在批准范围内改文件。

本仓库是本地优先的 AI 编码工具任务监控桌面软件。不要把监控对象的会话文件、`runtime.json` token、或 `.env*` 写入仓库。不要自动 commit / push / `git init`。

手册：[`.agents/AI-CODING.md`](.agents/AI-CODING.md)

## 按需读取

| 任务 | 先读 |
| --- | --- |
| 跨包 / 新模块 | [`.agents/rules/package-boundaries.md`](.agents/rules/package-boundaries.md) → [`.agents/knowledge/architecture.md`](.agents/knowledge/architecture.md) |
| 适配器 / 探测 / 事件映射 | [`.agents/rules/adapter-contract.md`](.agents/rules/adapter-contract.md) |
| 渲染层 UI | [`.agents/rules/renderer-native.md`](.agents/rules/renderer-native.md) |
| 扫描、API、TTS、隐私 | [`.agents/rules/local-first.md`](.agents/rules/local-first.md) → [`.agents/knowledge/constraints.md`](.agents/knowledge/constraints.md) |
| 验证怎么跑 | [`.agents/knowledge/verification.md`](.agents/knowledge/verification.md) |
| 产品/设计编号 | [`docs/README.md`](docs/README.md) |

规则正文只在 `.agents/rules/`。`.cursor/rules/` 仅作触发，不复制正文。

## 可用流程

无原生发现时显式读取：

- 交付功能：[`.agents/skills/deliver-feature/SKILL.md`](.agents/skills/deliver-feature/SKILL.md)
- 只读审查：[`.agents/skills/review-readonly/SKILL.md`](.agents/skills/review-readonly/SKILL.md)
- 同步知识：[`.agents/skills/sync-knowledge/SKILL.md`](.agents/skills/sync-knowledge/SKILL.md)
- 新增适配器：[`.agents/skills/add-adapter/SKILL.md`](.agents/skills/add-adapter/SKILL.md)

模板：[`.agents/templates/task-brief.md`](.agents/templates/task-brief.md)、[`.agents/templates/review-handoff.md`](.agents/templates/review-handoff.md)

## 命令

```bash
pnpm install
pnpm dev
sh scripts/l1-verify.sh
```

## 安全与交付

不读凭证与私人历史。不向被监控工具写入指令。报告实际验证与未验证项。静态阅读不等于测试通过。
