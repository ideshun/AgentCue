# 包边界

## 适用范围

新增 import、拆包、改 `tsconfig` 路径别名、或让 apps 直接引用另一包内部文件时。

## 应保持行为

- 依赖只允许 `schema ← store ← core ← adapters / apps`。禁止反向或跨越（例如 desktop 深链 store 内部文件、core 引用 adapters）。
- 跨包使用包名：`@awm/schema`、`@awm/store`、`@awm/core`、`@awm/adapters`。禁止 `../../packages/*` 或 `**/packages/*/src/**`。ESLint `no-restricted-imports` 已生效（`eslint.config.mjs`）。
- 事件、状态、manifest、API 类型从 `@awm/schema` 导入，不在消费包重定义平行类型。
- `awm-mcp`（`apps/mcp-stdio`）只读握手文件并调用控制 API，不打开 SQLite。
- JS/TS 需要方法注释时用 JSDoc，方法说明使用 `@description: `；只注释非显而易见逻辑。

## 待确认

- `mcp_servers` 表已有 DDL，尚无 DAO；补 DAO 时仍放 `packages/store`，不要在 core 直接写 SQL。

## 验证边界

`pnpm lint` 覆盖跨包相对路径。跨包类型改动跑 `pnpm typecheck`（会先 build）。相关 DAO / schema 单测用 `pnpm test` 的最小文件集。
