# 适配器契约

## 适用范围

新增或修改 `packages/adapters`、manifest YAML、事件提取器、探测路径，或改 `packages/core` 中可能出现工具名的代码时。

## 应保持行为

- 新增工具 = 新 YAML（`packages/adapters/resources/adapters/`）+ 可选 TS 提取器。不改 core 去认识某个工具。
- `packages/core/src` 禁止具体工具名。守护测试：`tests/contract/no-tool-name.test.ts`。
- manifest 由 `@awm/schema` 的 `adapterManifestSchema` 校验。空 `eventMapping: {}` 合法，表示只探测、不产生会话事件。
- 没有真实会话样本时禁止填写 `eventMapping` 或编写提取器。Cursor 的 `state.vscdb` 无公开契约，保持空映射。
- 提取器把原始行映射为 `@awm/schema` 的 `StandardEvent`。参照 `packages/adapters/src/claude-code/extract.ts` 与 `tests/contract/adapters/claude-code/`。
- 探测路径只使用 manifest 声明的 `configPaths` / `processNames` / `apis` / `sessionSource.pathPattern`，含平台变体与 `envOverride`。
- 热加载尚未实现：改 YAML 后需重新加载应用，不要假设 `fs.watch` 已存在。

## 待确认

- Codex 已按公开 rollout 映射 `task_started` / `task_complete` / `turn_aborted`；审批瞬时事件不入库，故无 waiting_human。
- 校验 CLI：`awm-adapter-validate <manifest.yaml>`（`packages/adapters/src/validate-cli.ts`）。

## 验证边界

新适配器至少：manifest 能被 loader 解析；有提取器则补一套 fixture 契约测试。改 core 后必须跑 `tests/contract/no-tool-name.test.ts`。
