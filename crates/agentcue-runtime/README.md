# 原生运行时

迁移中的 AgentCue 后台模块，尚未替换安装版 Electron 应用。入口由未来的 Tauri 宿主负责单实例保护、显式数据目录、服务启动与退出。

- `state` / `settings`：运行状态、设置合并、原子文件写入与即时读取资格撤销。
- `queries` / `control` / `api`：现有页面的查询、分列分页、任务标记、规则、通知读状态和回环 API；使用 Bearer 鉴权、独立限流和一次性 SSE 票据。
- `discovery` / `capture` / `monitor`：只遍历已声明目录，跳过符号链接；独立消费检查点与心跳，支持追加、半行、截断、替换、跨批标题和内部来源过滤。
- `hooks` / `hook_cli`：原生观察型 Hooks，缺失开始和终态恢复在事务内处理；重复和合成事件不重复播报。
- `mcp` / `mcp_client` / `mcp_servers`：不打开数据库的 stdio 桥接、外部 stdio/HTTP 验证和配置持久化；验证连接结束后标为 disconnected。

语音队列、TTS 后端、桌面窗口/托盘/通知、文件选择和完整打包仍待接入。模块测试只使用隔离数据；不得直接打开用户数据目录来替代升级验收。

验证：`pnpm rust:verify`。兼容夹具更新：`pnpm rust:contract`。
