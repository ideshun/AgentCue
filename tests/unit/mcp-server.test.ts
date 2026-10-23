/**
 * MCP Server 协议单测：初始化、工具清单、工具调用与错误分支。
 * 用假 invoker，不发起任何网络请求。
 */
import { describe, expect, it } from 'vitest';
import type { Envelope } from '@awm/schema';
import { McpServer, PROTOCOL_VERSION } from '../../apps/mcp-stdio/src/server';

/** 构造带固定返回值的 server */
function createServer(result: Envelope): McpServer {
  return new McpServer({
    invoke: async () => result,
    version: 'test',
  });
}

describe('McpServer', () => {
  it('initialize 返回协议版本与 tools 能力', async () => {
    const server = createServer({ success: true });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const result = response?.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
    };
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.capabilities.tools).toBeDefined();
  });

  it('tools/list 返回 6 个工具', async () => {
    const server = createServer({ success: true });
    const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = response?.result as { tools: unknown[] };
    expect(result.tools).toHaveLength(6);
  });

  it('未知工具返回 -32602', async () => {
    const server = createServer({ success: true });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'drop_database', arguments: {} },
    });
    expect(response?.error?.code).toBe(-32602);
  });

  it('工具调用成功时 isError 为 false 且内容为 envelope JSON', async () => {
    const server = createServer({ success: true, data: [{ toolId: 'demo' }] });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_tools', arguments: {} },
    });
    const result = response?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ success: true });
  });

  it('工具返回失败时 isError 为 true', async () => {
    const server = createServer({
      success: false,
      error: { code: 'NOT_FOUND', message: '会话不存在' },
    });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_task_status', arguments: { sessionId: 'x' } },
    });
    const result = response?.result as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it('通知消息不产生响应', async () => {
    const server = createServer({ success: true });
    const response = await server.handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(response).toBeNull();
  });

  it('未知方法返回 -32601', async () => {
    const server = createServer({ success: true });
    const response = await server.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    expect(response?.error?.code).toBe(-32601);
  });

  it('非法消息返回 -32600', async () => {
    const server = createServer({ success: true });
    const response = await server.handle({ id: 7, method: 'initialize' });
    expect(response?.error?.code).toBe(-32600);
  });
});
