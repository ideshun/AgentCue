#!/usr/bin/env node
/**
 * awm-mcp 桥接入口（P4 进程）。
 *
 * AI 客户端按 MCP stdio 协议拉起本进程：stdin 逐行读 JSON-RPC，stdout 逐行写响应。
 * 业务数据一律转发给本机控制 API，桥接进程本身不碰数据库（单一写者原则）。
 */
import { runStdio } from './stdio';

export { runStdio } from './stdio';

if (require.main === module) {
  void runStdio().catch((error: unknown) => {
    process.stderr.write(
      `awm-mcp 退出：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
