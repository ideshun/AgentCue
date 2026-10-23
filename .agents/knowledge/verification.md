# 验证与命令

## 适用范围

改代码或配置后选择验证级别、定位失败日志、判断是否需要 UI 实测时读取。纯问答不使用。

## 来源路径 / 符号

- 仓库脚本：`scripts/l1-verify.sh`
- 根脚本：`package.json` 的 `typecheck` / `test` / `lint` / `dev` / `dist`
- 测试布局：`packages/**/*.test.ts`、`tests/contract/`、`tests/integration/`、`tests/unit/`
- 设计分级：`docs/design/detailed-design.md` 第 9.2 节
- ESLint 边界：`eslint.config.mjs`

## 当前实现

**L1（默认）**：`sh scripts/l1-verify.sh`。顺序为 typecheck → 全部 vitest → lint，完整输出写入 `.verify/l1.log`。`.verify/` 已被 gitignore。

改动面较小时可只跑相关子集，但交付涉及跨包类型或公共模块时仍应跑 L1：

```bash
pnpm typecheck
pnpm test
pnpm lint
```

注意：`pnpm typecheck` 会先 `pnpm -r run build`（`pretypecheck`），因为跨包解析依赖 `dist/*.d.ts`。单测通过 vitest alias 直连源码，不依赖构建产物。`vitest.config.ts` 的 include 是 `packages/**/*.test.ts` 与 `tests/**/*.test.ts`，**不跑 `apps/`**。

**L2**：里程碑或发布前的全量测试 / 多模块联调。现有契约与集成测试已含在 `pnpm test` 内。

**L3**：dev server、窗口操作、截图、E2E。默认禁止。仅在用户明确要求、复杂交互、或问题只能运行时观察时执行。`pnpm dev` 本身不是验证结果。

现有契约锚点：

- core 零工具名：`tests/contract/no-tool-name.test.ts`
- manifest：`tests/contract/adapter-manifest.test.ts`
- claude-code 提取：`tests/contract/adapters/claude-code/extract.contract.test.ts`
- Codex 提取：`tests/contract/adapters/codex/extract.contract.test.ts`
- MCP 工具名：`tests/contract/mcp-tools.test.ts`
- 监控链路：`tests/integration/monitor-service.test.ts`
- 进程内时延预算：`tests/perf/latency-report.test.ts`

## 待确认

- CI 工作流 `.github/workflows/l1.yml` 已写；本仓库若尚未接入远程则不会实际跑。
- 渲染层与 Electron 主进程无自动测试。
- 10×100 会话浸泡压测未做，现有预算测试不启动 Electron。

## 更新触发

验证脚本、测试 include、跨包构建方式、或 L3 白名单变化时更新本页。
