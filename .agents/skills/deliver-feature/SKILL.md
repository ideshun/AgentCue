---
name: deliver-feature
description: >-
  在本仓库交付或修改功能。适用于实现 FR/TODO、修 bug、补测试、改桌面主进程或包内逻辑。
  不适用于只读问答、纯文档整理、或未获准的范围扩张。
---

# 功能交付

## 输入

- 目标（FR 编号、TODO 编号、或可观察行为）
- 批准范围（允许改的包/文件）
- 不可接受的结果（若有）

## 步骤

1. 确认仓库根包含项目 `package.json` 和 Git 元数据；目录可叫 `AgentCue` 或 `ai-workflow-monitor`。读 [AGENTS.md](../../../AGENTS.md) 与相关规则，不全量预加载。
2. 用源码核对当前行为，区分证据与假设。产品文档 RTM 仍写「待开发」，以源码和 [README.md](../../../README.md) 已交付表为准，缺口见 [architecture.md](../../knowledge/architecture.md) 的待确认。
3. 选最小方案：复用现有 DAO、FSM、`TRANSITION_TABLE`、控制 API。不引入新运行时依赖，除非已有 ADR。
4. 按包边界改代码。涉及适配器时走 [add-adapter](../add-adapter/SKILL.md)。涉及渲染层时遵守 [renderer-native.md](../../rules/renderer-native.md)。
5. 对照 [task-brief.md](../../templates/task-brief.md) 记录范围与验证。方法注释需要时用 JSDoc，`@description: ` 写说明。
6. 按 [verification.md](../../knowledge/verification.md) 跑与改动相关的最小检查。跨包则 `sh scripts/l1-verify.sh`。

## 暂停

- 需要真实会话样本才能写 `eventMapping`，而样本不存在。
- 改变出网、权限、CI、依赖、或产品边界（代操作 / 云同步）。
- 迁 React、拆扫描子进程、或回滚 ADR-11~16。

## 输出

- 改动文件与行为变化
- 实际执行的验证命令与退出码（未跑的标明未执行）
- 未做项与剩余风险
