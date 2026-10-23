/** Shared stdio entry for the CLI and the packaged desktop executable. */
import { createInterface } from 'node:readline';
import { ControlApiClient } from './client';
import { McpServer, type JsonRpcResponse } from './server';

/** @description: Serve MCP without loading Electron desktop services or opening SQLite. */
export function runStdio(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  errors: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  const client = new ControlApiClient();
  const server = new McpServer({
    invoke: (tool, args) => client.invoke(tool, args),
    version: '0.1.0',
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  const write = (response: JsonRpcResponse): void => {
    output.write(`${JSON.stringify(response)}\n`);
  };
  lines.on('line', (line: string) => {
    if (line.trim() === '') return;
    queue = queue.then(async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
        return;
      }
      try {
        const response = await server.handle(raw);
        if (response) write(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.write(`awm-mcp 处理失败：${message}\n`);
        write({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: '本地控制 API 调用失败' },
        });
      }
    });
  });
  return new Promise((resolve, reject) => {
    lines.once('close', () => {
      void queue.then(resolve, reject);
    });
    lines.once('error', reject);
    input.once('error', reject);
  });
}
