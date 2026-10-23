# 项目 AI 工作流使用手册

## 从哪里开始

根入口 [AGENTS.md](../AGENTS.md) 只保留工作边界与阅读路由。按任务读下面列出的规则、流程和知识，不要一次加载全部文件。

规则正文只维护在 `.agents/rules/`。原生触发文件若存在于 `.cursor/rules/`，只做短路由，不复制第二套正文。

## 文件导航

| 路径 | 用途 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 工作边界、任务→文件路由、命令 |
| [knowledge/architecture.md](./knowledge/architecture.md) | 包、进程、数据流、适配器水位 |
| [knowledge/constraints.md](./knowledge/constraints.md) | C 约束与 ADR-11~16 |
| [knowledge/verification.md](./knowledge/verification.md) | L1/L2/L3 与真实命令 |
| [rules/package-boundaries.md](./rules/package-boundaries.md) | `@awm/*` 依赖方向 |
| [rules/adapter-contract.md](./rules/adapter-contract.md) | manifest、零工具名、禁止编造映射 |
| [rules/renderer-native.md](./rules/renderer-native.md) | 渲染层无框架 |
| [rules/local-first.md](./rules/local-first.md) | 扫描、API、隐私 |
| [skills/deliver-feature/SKILL.md](./skills/deliver-feature/SKILL.md) | 功能交付 |
| [skills/review-readonly/SKILL.md](./skills/review-readonly/SKILL.md) | 只读审查 |
| [skills/sync-knowledge/SKILL.md](./skills/sync-knowledge/SKILL.md) | 实现后同步知识 |
| [skills/add-adapter/SKILL.md](./skills/add-adapter/SKILL.md) | 新增适配器 |
| [templates/task-brief.md](./templates/task-brief.md) | 任务约定 |
| [templates/review-handoff.md](./templates/review-handoff.md) | 审查交接 |
| [docs/README.md](../docs/README.md) | 产品/设计/ADR 索引 |

`.agents/` 被读取不等于已被所有客户端自动发现或触发。

## 日常任务

**定位**：从 [architecture.md](./knowledge/architecture.md) 找包，再打开对应 `src/`。需求编号在 `docs/product/product-design.md`（FR）与 `docs/design/detailed-design.md` 第 10 章（TODO）。文档状态可能落后于代码。

**实施**：显式读取 [deliver-feature/SKILL.md](./skills/deliver-feature/SKILL.md)。改适配器用 [add-adapter/SKILL.md](./skills/add-adapter/SKILL.md)。

**审查**：显式读取 [review-readonly/SKILL.md](./skills/review-readonly/SKILL.md)，用 [review-handoff.md](./templates/review-handoff.md) 交卷。

**知识维护**：架构或约束变化后走 [sync-knowledge/SKILL.md](./skills/sync-knowledge/SKILL.md)。

常用命令（细节见 [verification.md](./knowledge/verification.md)）：

```bash
pnpm install
pnpm dev
sh scripts/l1-verify.sh
```

## 维护与验收方法

- 入口只维护边界与路由；流程放 Skills；事实放 knowledge。
- 改完检查：修改范围、相对链接有效、验证有命令与退出码。
- 不预填某次运行的通过结果。静态读文件不等于测试通过。
- 不自动 `git commit` / `git push`。仓库若尚未初始化 git，不要擅自 `git init`。
