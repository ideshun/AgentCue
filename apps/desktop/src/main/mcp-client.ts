/** External MCP connections are short lived validation sessions, never task-event sources. */
import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BYTES = 1024 * 1024;
const MAX_PAGES = 100;

export interface ExternalMcpTool {
  name: string;
  description?: string;
}

export interface McpConnectResult {
  ok: boolean;
  /** A validation session has already closed when this result is returned. */
  status: 'disconnected';
  validationStatus: 'verified' | 'error';
  tools: ExternalMcpTool[];
  lastValidatedAt: string;
  lastError: string | null;
  /** Compatibility for callers that previously consumed error. */
  error?: string;
}

export interface McpValidationOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

type RpcObject = Record<string, unknown>;

function object(value: unknown): value is RpcObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function result(tools: ExternalMcpTool[], error?: unknown): McpConnectResult {
  const message =
    error === undefined ? null : error instanceof Error ? error.message : String(error);
  return {
    ok: message === null,
    status: 'disconnected',
    validationStatus: message === null ? 'verified' : 'error',
    tools: message === null ? tools : [],
    lastValidatedAt: new Date().toISOString(),
    lastError: message,
    ...(message === null ? {} : { error: message }),
  };
}

function rpcResult(payload: unknown, expectedId: number): RpcObject | null {
  if (!object(payload) || payload.jsonrpc !== '2.0') {
    throw new Error('MCP 返回的消息不是有效 JSON-RPC 对象');
  }
  if (!('id' in payload) && typeof payload.method === 'string') return null;
  if (typeof payload.method === 'string') return null;
  if (payload.id !== expectedId) throw new Error(`MCP 响应 id 不匹配（期待 ${expectedId}）`);
  if ('error' in payload) {
    const error = payload.error;
    throw new Error(
      object(error) && typeof error.message === 'string' ? error.message : 'MCP 返回错误响应',
    );
  }
  if (!object(payload.result)) throw new Error('MCP 响应缺少有效 result');
  return payload.result;
}

function initializeResult(value: RpcObject): boolean {
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`MCP 协议版本不受支持：${String(value.protocolVersion)}`);
  }
  if (
    !object(value.capabilities) ||
    !object(value.serverInfo) ||
    typeof value.serverInfo.name !== 'string'
  ) {
    throw new Error('MCP 初始化响应缺少 capabilities 或 serverInfo');
  }
  return object(value.capabilities.tools);
}

function toolPage(value: RpcObject): { tools: ExternalMcpTool[]; nextCursor?: string } {
  if (!Array.isArray(value.tools)) throw new Error('MCP 工具列表不是数组');
  const tools = value.tools.map((tool: unknown) => {
    if (!object(tool) || typeof tool.name !== 'string' || tool.name.trim() === '') {
      throw new Error('MCP 工具列表含无效工具名称');
    }
    return {
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    };
  });
  if (value.nextCursor !== undefined && typeof value.nextCursor !== 'string')
    throw new Error('MCP 分页游标无效');
  return { tools, nextCursor: value.nextCursor as string | undefined };
}

/** @description: Validate initialization and enumerate tools, then close the subprocess. */
export async function listStdioMcpTools(
  command: string,
  args: string[] = [],
  options: McpValidationOptions = {},
): Promise<McpConnectResult> {
  if (command.trim() === '') return result([], '请填写 MCP 可执行文件');
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // The validator owns this process group, including command wrappers such as npx.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve(result([], error));
      return;
    }
    let settled = false;
    let buffer = '';
    let stderr = '';
    let receivedBytes = 0;
    let expectedId = 1;
    let phase: 'initialize' | 'tools' = 'initialize';
    let pages = 0;
    const tools: ExternalMcpTool[] = [];
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      if (child.pid !== undefined) {
        const terminate = (signal: NodeJS.Signals): void => {
          try {
            if (process.platform !== 'win32' && child.pid !== undefined)
              process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {
            /* Process group already exited. */
          }
        };
        terminate('SIGTERM');
        const killTimer = setTimeout(() => terminate('SIGKILL'), 200);
        killTimer.unref();
        if (process.platform === 'win32') {
          const cleanup = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
          });
          cleanup.on('error', () => undefined);
          cleanup.unref();
          child.once('close', () => clearTimeout(killTimer));
        }
      }
      resolve(result(tools, error));
    };
    const timer = setTimeout(() => finish('MCP 验证超时'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const send = (payload: unknown): void => {
      if (!settled) child.stdin?.write(`${JSON.stringify(payload)}\n`);
    };
    child.on('error', (error: Error) => finish(`MCP 启动失败：${error.message}`));
    child.stdin?.on('error', (error: Error) => finish(`MCP 输入管道失败：${error.message}`));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on('close', (code, signal) => {
      if (!settled)
        finish(
          `MCP 提前退出（${String(code ?? signal)}）${stderr.trim() ? `：${stderr.trim()}` : ''}`,
        );
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > maxBytes) {
        finish('MCP 输出超过验证大小上限');
        return;
      }
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0 || settled) return;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line === '') continue;
        try {
          const payload: unknown = JSON.parse(line);
          if (object(payload) && typeof payload.method === 'string' && 'id' in payload) {
            send({
              jsonrpc: '2.0',
              id: payload.id,
              error: { code: -32601, message: 'Client does not support this method' },
            });
            continue;
          }
          const response = rpcResult(payload, expectedId);
          if (!response) continue;
          if (phase === 'initialize') {
            const hasTools = initializeResult(response);
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            if (!hasTools) {
              finish();
              return;
            }
            phase = 'tools';
            expectedId += 1;
            send({ jsonrpc: '2.0', id: expectedId, method: 'tools/list', params: {} });
          } else {
            const page = toolPage(response);
            tools.push(...page.tools);
            pages += 1;
            if (page.nextCursor !== undefined) {
              if (pages >= MAX_PAGES) throw new Error('MCP 工具分页超过验证上限');
              expectedId += 1;
              send({
                jsonrpc: '2.0',
                id: expectedId,
                method: 'tools/list',
                params: { cursor: page.nextCursor },
              });
            } else finish();
          }
        } catch (error) {
          finish(
            error instanceof SyntaxError
              ? 'MCP stdout 含非 JSON 协议消息；日志应写入 stderr'
              : error,
          );
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: expectedId,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ai-workflow-monitor', version: '0.1.0' },
      },
    });
  });
}

/** Read bounded JSON or SSE until the response matching the request arrives. */
async function readHttpResponse(
  response: Response,
  id: number,
  maxBytes: number,
): Promise<RpcObject> {
  if (!response.body) throw new Error('MCP HTTP 返回空响应');
  const contentType = response.headers.get('content-type') ?? '';
  const isSse = contentType.includes('text/event-stream');
  if (!isSse && !contentType.includes('application/json'))
    throw new Error('MCP HTTP 响应须为 JSON 或 SSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        if (!isSse) {
          const parsed = rpcResult(JSON.parse(buffer) as unknown, id);
          if (parsed) return parsed;
        }
        throw new Error('MCP HTTP 流结束前未返回匹配响应');
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('MCP HTTP 响应超过验证大小上限');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (!isSse) continue;
      buffer = buffer.replace(/\r\n/g, '\n');
      let separator: number;
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data === '') continue;
        const parsed = rpcResult(JSON.parse(data) as unknown, id);
        if (parsed) return parsed;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** @description: Validate a Streamable HTTP session, including negotiated headers and SSE replies. */
export async function listHttpMcpTools(
  url: string,
  options: McpValidationOptions = {},
): Promise<McpConnectResult> {
  let sessionId: string | null = null;
  let initialized = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const tools: ExternalMcpTool[] = [];
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
      throw new Error('MCP URL 须使用 http 或 https');
    const post = async (payload: unknown): Promise<Response> => {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
      return response;
    };
    const response = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ai-workflow-monitor', version: '0.1.0' },
      },
    });
    sessionId = response.headers.get('mcp-session-id');
    const init = await readHttpResponse(response, 1, options.maxBytes ?? MAX_BYTES);
    const hasTools = initializeResult(init);
    headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
    if (sessionId) headers['MCP-Session-Id'] = sessionId;
    initialized = true;
    const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await notified.body?.cancel();
    if (hasTools) {
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        const id = pageNumber + 2;
        const listed = await post({
          jsonrpc: '2.0',
          id,
          method: 'tools/list',
          params: cursor === undefined ? {} : { cursor },
        });
        const page = toolPage(await readHttpResponse(listed, id, options.maxBytes ?? MAX_BYTES));
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor === undefined) break;
        if (pageNumber === MAX_PAGES - 1) throw new Error('MCP 工具分页超过验证上限');
      }
    }
    return result(tools);
  } catch (error) {
    return result([], controller.signal.aborted ? 'MCP HTTP 验证超时' : error);
  } finally {
    clearTimeout(timer);
    if (initialized && sessionId) {
      await fetch(url, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(1000),
        redirect: 'error',
      })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    }
  }
}
