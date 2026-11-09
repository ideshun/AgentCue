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

Rust 迁移模块按 [ADR-21](../../docs/adr/ADR-21-rust-tauri-migration.md) 独立验证：`pnpm rust:verify` 运行 workspace 格式检查以及核心库的 Clippy 与 Rust 测试，`pnpm rust:contract` 从构建后的 TS 包重新导出兼容夹具。现有 Vitest 中的 `rust-state-contract.test.ts` 检查夹具仍与当前 TS 行为一致；`rust-store-contract.test.ts` 检查五版 SQL 与 TS 存储一致；`rust-runtime-contract.test.ts` 校验共享设置、接入模板、出厂规则及适配器合成夹具；L1 workflow 设有独立 Rust job，不以 TS 测试通过代替 Rust 测试通过。Rust API/MCP 集成测试需要允许临时回环监听和模拟子进程，不能在权限受限时静默跳过；采集、数据库与设置测试不读取用户真实目录。

## 待确认

- `.github/workflows/l1.yml` 在 main/PR 执行；`.github/workflows/release.yml` 对已有版本标签运行 L1，并原生构建/自检 macOS 双架构、Windows x64 与 Linux x64，发布草稿预览版和 SHA-256。
- `.github/workflows/native-release.yml` 为 Tauri 打包和发布草稿。手动运行只产出构建包，`v1.*` 标签进入草稿流程。用 `pnpm tauri:bundle` 在本机复现，打包后运行可执行文件的 `--self-test`，再用隔离窗口检查原生交互和真实试听。
- 主进程模块（api-server / monitor-service / voice-service / hook-setup 等）与渲染层纯函数逻辑有单测覆盖（`tests/unit/`，渲染层经 vm 直跑原生脚本）；Electron 窗口与真实交互无自动测试。
- 10×100 会话浸泡压测未做，现有预算测试不启动 Electron。

## 更新触发

验证脚本、测试 include、跨包构建方式、或 L3 白名单变化时更新本页。
