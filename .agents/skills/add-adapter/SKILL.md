---
name: add-adapter
description: >-
  按现有 claude-code 模式新增或补全适配器（manifest、可选提取器、契约 fixture）。
  适用于探测路径、会话文件映射、事件提取。无真实会话样本时不要编造 eventMapping。
  不修改 packages/core 去识别具体工具。
---

# 新增适配器

## 输入

- 工具 id（kebab-case，与 manifest `id` 一致）
- 已核实的配置路径、进程名、会话文件位置与格式样本
- 要映射的语义（`waiting_human` / `completed` / `failed` 等）

## 步骤

1. 读 [adapter-contract.md](../../rules/adapter-contract.md) 与 `packages/adapters/resources/adapters/claude-code.manifest.yaml`。
2. 在 `packages/adapters/resources/adapters/<id>.manifest.yaml` 声明 `detect`、`sessionSource`、`heartbeat`。字段必须能通过 `adapterManifestSchema`。
3. 仅当有真实会话样本时填写 `eventMapping`，并在 `packages/adapters/src/<id>/extract.ts` 写提取器（仿 `claude-code/extract.ts`）。输出 `StandardEvent`，工具名只出现在 adapters 包。
4. 无样本：保持 `eventMapping: {}`，在 YAML 注释写明缺什么。不要为了「看起来完整」编匹配规则。
5. 契约测试：
   - 有提取器：`tests/contract/adapters/<id>/` 放 sample 与 expected events
   - 所有内置 YAML：`tests/contract/adapter-manifest.test.ts` 能加载
6. 跑 `tests/contract/no-tool-name.test.ts`，确认 core 仍零工具名。
7. 需要时更新 [architecture.md](../../knowledge/architecture.md) 的适配器清单。

## 暂停

- 会话格式未核实（例如 Cursor `state.vscdb`）。
- 需要在 core 写 `if (toolId === '...')`。
- 用户要监控的工具没有独立进程名和稳定本地会话文件（如 GitHub Copilot 现状）。

## 输出

- 新增/修改的 manifest 与提取器路径
- 是否产生事件（有映射 vs 仅探测）
- 测试命令与结果
