import { afterEach, describe, expect, it, vi } from 'vitest';
import { listHttpMcpTools, listStdioMcpTools } from '../../apps/desktop/src/main/mcp-client';

const initResult = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'fixture', version: '1' },
};

function script(behavior: string): string[] {
  return [
    '-e',
    `const readline=require('node:readline'); const init=${JSON.stringify(initResult)}; const send=v=>process.stdout.write(JSON.stringify(v)+'\\n'); readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line); ${behavior}});`,
  ];
}

const options = { timeoutMs: 2000 };
afterEach(() => vi.unstubAllGlobals());

function httpFixture(
  handle: (request: RequestInit, payload: Record<string, unknown>) => Response | Promise<Response>,
): string {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, request: RequestInit = {}) => {
      return handle(
        request,
        typeof request.body === 'string'
          ? (JSON.parse(request.body) as Record<string, unknown>)
          : {},
      );
    }),
  );
  return 'http://127.0.0.1:47831/mcp-fixture';
}

describe('external MCP stdio validation', () => {
  it('ignores notifications, writes NDJSON, accepts an empty tools list, and disconnects', async () => {
    const result = await listStdioMcpTools(
      process.execPath,
      script(
        `if(request.method==='initialize'){send({jsonrpc:'2.0',method:'notifications/message',params:{}});send({jsonrpc:'2.0',id:request.id,result:init});}else if(request.method==='tools/list')send({jsonrpc:'2.0',id:request.id,result:{tools:[]}});`,
      ),
      options,
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'disconnected',
      validationStatus: 'verified',
      tools: [],
      lastError: null,
    });
    expect(result.lastValidatedAt).toBeTruthy();
  });

  it('enumerates multiple tools pages', async () => {
    const result = await listStdioMcpTools(
      process.execPath,
      script(
        `if(request.method==='initialize')send({jsonrpc:'2.0',id:request.id,result:init});else if(request.method==='tools/list')send({jsonrpc:'2.0',id:request.id,result:request.params.cursor?{tools:[{name:'second'}]}:{tools:[{name:'first'}],nextCursor:'next'}});`,
      ),
      options,
    );
    expect(result.tools.map((tool) => tool.name)).toEqual(['first', 'second']);
  });

  it('reports non JSON stdout rather than throwing in the main process', async () => {
    const result = await listStdioMcpTools(
      process.execPath,
      ['-e', "process.stdout.write('ordinary log\\n');setTimeout(()=>{},5000)"],
      options,
    );
    expect(result.ok).toBe(false);
    expect(result.lastError).toContain('非 JSON');
  });

  it('rejects mismatched response ids and JSON-RPC errors', async () => {
    const mismatch = await listStdioMcpTools(
      process.execPath,
      script("send({jsonrpc:'2.0',id:999,result:init});"),
      options,
    );
    expect(mismatch.lastError).toContain('id 不匹配');
    const error = await listStdioMcpTools(
      process.execPath,
      script("send({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'fixture failed'}});"),
      options,
    );
    expect(error).toMatchObject({ ok: false, lastError: 'fixture failed' });
  });

  it('reports malformed result shapes instead of an empty successful list', async () => {
    const result = await listStdioMcpTools(
      process.execPath,
      script(
        "if(request.method==='initialize')send({jsonrpc:'2.0',id:request.id,result:init});else if(request.method==='tools/list')send({jsonrpc:'2.0',id:request.id,result:{tools:'invalid'}});",
      ),
      options,
    );
    expect(result).toMatchObject({ ok: false, tools: [] });
    expect(result.lastError).toContain('不是数组');
  });

  it('handles startup failure, early exit, bounded output, and timeout', async () => {
    const missing = await listStdioMcpTools('/nonexistent/awm-fixture-command', [], options);
    expect(missing.lastError).toContain('启动失败');
    const exit = await listStdioMcpTools(process.execPath, ['-e', 'process.exit(7)'], options);
    expect(exit.lastError).toContain('提前退出');
    const huge = await listStdioMcpTools(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(10000));setTimeout(()=>{},5000)"],
      { ...options, maxBytes: 64 },
    );
    expect(huge.lastError).toContain('大小上限');
    const timeout = await listStdioMcpTools(process.execPath, ['-e', 'setInterval(()=>{},5000)'], {
      timeoutMs: 60,
    });
    expect(timeout.lastError).toContain('超时');
  });
});

describe('external MCP Streamable HTTP validation', () => {
  it('initializes, retains session and protocol headers, reads SSE and terminates the session', async () => {
    let initialized = false;
    let deleted = false;
    const url = httpFixture((request, payload) => {
      if (request.method === 'DELETE') {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      const headers = new Headers(request.headers);
      expect(headers.get('accept')).toContain('text/event-stream');
      if (payload.method === 'initialize') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: initResult }),
          { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-session' } },
        );
      }
      expect(headers.get('mcp-session-id')).toBe('fixture-session');
      expect(headers.get('mcp-protocol-version')).toBe('2025-06-18');
      if (payload.method === 'notifications/initialized') {
        initialized = true;
        return new Response(null, { status: 202 });
      }
      expect(initialized).toBe(true);
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: [{ name: 'fixture_tool', description: 'local test' }] } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const result = await listHttpMcpTools(url, options);
    expect(result).toMatchObject({
      ok: true,
      status: 'disconnected',
      tools: [{ name: 'fixture_tool' }],
    });
    expect(deleted).toBe(true);
  });

  it('reports protocol errors and HTTP timeout', async () => {
    const errorUrl = httpFixture(
      (_request, payload) =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            error: { code: -32603, message: 'HTTP fixture failure' },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    expect((await listHttpMcpTools(errorUrl, options)).lastError).toBe('HTTP fixture failure');
    const hangingUrl = httpFixture(
      (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    );
    expect((await listHttpMcpTools(hangingUrl, { timeoutMs: 60 })).lastError).toContain('超时');
  });
});
