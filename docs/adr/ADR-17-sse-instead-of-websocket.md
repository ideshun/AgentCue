# ADR-17 控制 API 实时通道用 SSE，不用 WebSocket

> 相对详细设计 ADR-06 的实现偏离。

## 背景

详细设计 ADR-06 选择本地 WebSocket hub，以便 UI 下行静音指令并与 MCP streamable-http 复用事件总线。实现期控制 API 只需要服务端向渲染层推送状态变更，反向指令已经走 HTTP PUT/POST 与 Electron IPC。

## 决策

实时通道使用 `GET /api/v1/stream` 的 SSE（`text/event-stream`）。Node `http.ServerResponse.write` 即可实现，不引入 `ws` 依赖。

## 影响

- 渲染层用 `EventSource`，符合 ADR-11 零前端依赖。
- schema 仍保留 `wsMessageSchema` 作为消息信封形状，实际传输不是 WebSocket。
- UI 不能经同一条实时通道下发指令；静音、扫描、设置仍走 HTTP / IPC。

## 回滚成本

低。`api-server.ts` 的 stream 分支与 `renderer/api.ts` 的 `EventSource` 是唯二实现点。
