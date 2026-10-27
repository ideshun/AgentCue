# 渲染层零依赖

## 适用范围

修改 `apps/desktop/src/renderer/**`、窗口加载方式、或提议引入前端框架 / 打包器时。

## 应保持行为

- 渲染层是原生 TypeScript + 手写 CSS（ADR-11）。`apps/desktop/tsconfig.renderer.json` 使用 `"module": "none"`。文件内无 `import` / `export`，编译产物由 `<script src>` 顺序加载。
- 不引入 React、Vue、Vite、Tailwind、Zustand 或其他渲染期依赖。构建链是 `tsc -p tsconfig.renderer.json`。
- 数据走本地控制 API（`fetch` + `EventSource` SSE）。渲染层不持有状态机，不直连 SQLite。
- 页面：总览 / 办公室（本地生成插画工位、真实图标工牌与 NPC 消息气泡）/ 看板（四个状态列 + 历史列，按钮归档/重试，无拖拽）/ 通知中心（支持级别筛选）/ 播报接入（按工具分组 Hooks / MCP）/ 适配器 / 设置。
- 需要组件化或拖拽时，先评估是否仍能在原生脚本内完成；迁 React 必须另开 ADR，改动面应限制在 `views.ts` / `app.ts`，`api.ts` 可复用。

## 待确认

- 设计 ADR-05 曾选 React 19；实现以 ADR-11 为准。不要按设计文档把 React 当当前栈。

## 验证边界

`tsc -p apps/desktop/tsconfig.renderer.json`。渲染层无自动测试；复杂交互才进入 L3，且需用户明确要求。文案或样式微调不启动 `pnpm dev`。
