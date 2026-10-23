/**
 * 本地控制 API（SM-4.2、详细设计 5.5）。
 *
 * 安全基线：仅绑定 127.0.0.1；Bearer token 校验；限流 120 req/min per token；全部调用记审计。
 * 实时通道用 SSE 而非 ws：Node 内置即可实现单向推送，避免引入额外依赖（见 README 工程决策）。
 *
 * CORS：渲染层从 `file://` 加载（origin 为 null），访问 127.0.0.1 属跨域，
 * 因此必须放行 `*` 并处理 OPTIONS 预检；鉴权仍由 Bearer token 兜底。
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mcpSnippets } from '@awm/adapters';
import {
  boardQuerySchema,
  getTimelineInputSchema,
  listSessionsInputSchema,
  setVoiceRuleInputSchema,
  updateTaskStateInputSchema,
} from '@awm/schema';
import type { AdapterManifest, Settings } from '@awm/schema';
import {
  IllegalTransitionError,
  listNativeVoices,
  type ModelStatus,
  type NativeVoiceList,
  type SpeakResult,
} from '@awm/core';
import { appendAudit, getLastHookEventAt } from '@awm/store';
import { hookIntegrations, HOOK_TOOLS, parseHookEnvelope } from './hook-setup';
import { listStdioMcpTools } from './mcp-client';
import type { DesktopMcpLaunch } from './mcp-launch';
import type { DesktopFacade } from './facade';
import type { Engine } from './engine-host';

/** 限流窗口与阈值 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

/** 试听文本上限：500 字生成+播放远超 30 秒播放超时，统一收敛到 200 字 */
const TEST_TEXT_LIMIT = 200;

/** 生成随机 token */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** SSE 客户端 */
interface SseClient {
  /** 响应对象 */
  res: ServerResponse;
}

/** 控制 API 配置 */
export interface ApiServerOptions {
  /** 监听端口，0 表示由系统分配 */
  port: number;
  /** 访问 token */
  token: string;
  /** 引擎门面 */
  facade: DesktopFacade;
  /** 监控引擎 */
  engine: Engine;
  /** 读取当前设置 */
  getSettings: () => Settings;
  /** 增量更新设置 */
  updateSettings: (patch: Record<string, unknown>) => Settings;
  /** 读取已加载适配器 */
  getAdapters: () => AdapterManifest[];
  /** 触发一次扫描，返回扫描任务 id */
  triggerScan: () => Promise<string>;
  /** 试听播报 */
  speakTest: (text: string) => Promise<SpeakResult>;
  getNativeVoices?: () => Promise<NativeVoiceList>;
  getMcpLaunch?: () => DesktopMcpLaunch;
  onVoiceRulesChanged?: () => void;
  /** 本地模型当前状态（瞬态，不进 settings）；缺省为 Kokoro */
  getModelState?: (kind?: ModelKind) => ModelStatus;
  /** 用户显式触发模型下载；任务在后台推进，状态经 model.progress SSE 广播 */
  startModelDownload?: (kind?: ModelKind) => void;
  /** 取消进行中的模型下载 */
  cancelModelDownload?: (kind?: ModelKind) => void;
}

/** 控制 API 句柄 */
export interface ApiServerHandle {
  /** HTTP 服务实例 */
  server: Server;
  /** 实际监听端口 */
  port: number;
  /** 广播一条 SSE 消息 */
  broadcast: (type: string, data: unknown) => void;
  /** 关闭服务 */
  close: () => Promise<void>;
}

/**
 * 读取请求体。
 * @param req 请求对象
 * @returns 请求体文本
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new RangeError('请求内容超过大小限制');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @description: 所有写入接口只接受 JSON 对象，避免无效请求落入默认写入路径。 */
type ModelKind = 'kokoro' | 'zipvoice';

/** @description: 本地模型种类；未知值按 Kokoro 处理，保持旧客户端可用。 */
function modelKind(value: unknown): 'kokoro' | 'zipvoice' {
  return value === 'zipvoice' ? 'zipvoice' : 'kokoro';
}

async function readObjectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse((await readBody(req)) || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('请求内容须为 JSON 对象');
  return value as Record<string, unknown>;
}

/**
 * 写 CORS 响应头。
 * @param res 响应对象
 */
function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * 写 JSON 响应。
 * @param res 响应对象
 * @param status 状态码
 * @param payload 响应体
 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  setCors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 启动本地控制 API 服务。
 * @param options 服务配置
 * @returns 服务句柄（会在监听就绪后 resolve）
 */
export async function startApiServer(options: ApiServerOptions): Promise<ApiServerHandle> {
  const clients = new Set<SseClient>();
  const hits = new Map<string, { count: number; start: number }>();
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      try {
        if (res.headersSent) res.end();
        else
          sendJson(res, 500, {
            success: false,
            error: { code: 'ENGINE_UNAVAILABLE', message: '服务暂不可用' },
          });
      } catch {
        res.destroy();
      }
    });
  });

  /**
   * 处理单个请求。
   * @param req 请求
   * @param res 响应
   */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${options.port}`);
    } catch {
      sendJson(res, 400, {
        success: false,
        error: { code: 'INVALID_PARAM', message: '请求地址无效' },
      });
      return;
    }
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // 预检请求不鉴权：浏览器不带 Authorization 头
    if (method === 'OPTIONS') {
      setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // SSE 通道放行在鉴权之前建立连接，但仍校验 token 查询参数
    if (pathname === '/api/v1/stream') {
      if (url.searchParams.get('token') !== options.token) {
        sendJson(res, 401, {
          success: false,
          error: { code: 'INVALID_PARAM', message: 'token 无效' },
        });
        return;
      }
      setCors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const client: SseClient = { res };
      clients.add(client);
      req.on('close', () => clients.delete(client));
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
      return;
    }

    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${options.token}`) {
      sendJson(res, 401, {
        success: false,
        error: { code: 'INVALID_PARAM', message: '缺少或错误的 token' },
      });
      return;
    }

    // 限流
    const now = Date.now();
    const bucket = hits.get(options.token);
    if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
      hits.set(options.token, { count: 1, start: now });
    } else if (bucket.count >= RATE_LIMIT_MAX) {
      sendJson(res, 429, {
        success: false,
        error: { code: 'RATE_LIMITED', message: '请求过于频繁' },
      });
      return;
    } else {
      bucket.count += 1;
    }

    try {
      await route(pathname, method, url, req, res);
    } catch (error) {
      const invalid =
        error instanceof SyntaxError ||
        error instanceof URIError ||
        error instanceof RangeError ||
        (error instanceof Error && error.name === 'ZodError');
      const illegal = error instanceof IllegalTransitionError;
      const message =
        error instanceof SyntaxError
          ? '请求 JSON 格式无效'
          : invalid
            ? '参数无效，请检查输入或刷新后重试'
            : error instanceof Error
              ? error.message
              : '服务暂不可用';
      if (options.getSettings().privacy.auditLog) {
        appendAudit(options.engine.database, {
          ts: new Date().toISOString(),
          actor: 'api',
          action: `${method} ${pathname}`,
          result: `error: ${message}`,
        });
      }
      sendJson(res, invalid ? 400 : illegal ? 409 : 500, {
        success: false,
        error: {
          code: invalid ? 'INVALID_PARAM' : illegal ? 'ILLEGAL_TRANSITION' : 'ENGINE_UNAVAILABLE',
          message,
        },
      });
    }
  }

  /**
   * 路由分发。
   * @param pathname 路径
   * @param method 方法
   * @param url 完整 URL
   * @param req 请求
   * @param res 响应
   */
  async function route(
    pathname: string,
    method: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const facade = options.facade;

    if (pathname === '/api/v1/health' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        version: '0.1.0',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }

    if (pathname === '/api/v1/overview' && method === 'GET') {
      sendJson(res, 200, { success: true, data: await facade.getOverview() });
      return;
    }

    if (pathname === '/api/v1/board' && method === 'GET') {
      const query = boardQuerySchema.parse(Object.fromEntries(url.searchParams));
      sendJson(res, 200, { success: true, data: await facade.getBoard(query) });
      return;
    }

    if (pathname === '/api/v1/tools' && method === 'GET') {
      sendJson(res, 200, { success: true, data: await facade.listTools() });
      return;
    }

    const ignoreMatch = /^\/api\/v1\/tools\/([^/]+)\/ignored$/.exec(pathname);
    if (ignoreMatch && method === 'POST') {
      const toolId = decodeURIComponent(ignoreMatch[1] ?? '');
      const body = await readObjectBody(req);
      if (typeof body.ignored !== 'boolean') throw new RangeError('ignored 须为布尔值');
      await facade.setToolIgnored(toolId, body.ignored === true);
      sendJson(res, 200, { success: true, data: { toolId, ignored: body.ignored === true } });
      return;
    }

    if (pathname === '/api/v1/adapters' && method === 'GET') {
      sendJson(res, 200, { success: true, data: options.getAdapters() });
      return;
    }

    if (pathname === '/api/v1/integrations/hooks' && method === 'GET') {
      const settings = options.getSettings();
      sendJson(res, 200, {
        success: true,
        data: hookIntegrations(options.getMcpLaunch?.(), (id) => ({
          lastEventAt: getLastHookEventAt(options.engine.database, id),
          enabled: settings.privacy.sessionFileRead && !settings.scan.ignoredToolIds.includes(id),
        })),
      });
      return;
    }

    if (pathname === '/api/v1/integrations/hooks' && method === 'POST') {
      const { event, mode } = parseHookEnvelope(await readObjectBody(req));
      const tool = event.toolId as keyof typeof HOOK_TOOLS;
      const canCommit = (): boolean => {
        const settings = options.getSettings();
        return settings.privacy.sessionFileRead && !settings.scan.ignoredToolIds.includes(tool);
      };
      if (!canCommit()) {
        sendJson(res, 200, { success: true, data: { accepted: false, reason: 'disabled' } });
        return;
      }
      const result = await options.engine.consumeHookEvent(
        event,
        mode,
        canCommit,
        HOOK_TOOLS[tool].name,
      );
      sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (pathname === '/api/v1/sessions' && method === 'GET') {
      const filter = listSessionsInputSchema.parse({
        state: url.searchParams.get('state') ?? undefined,
        toolId: url.searchParams.get('toolId') ?? undefined,
        limit: Number(url.searchParams.get('limit') ?? 50),
      });
      sendJson(res, 200, {
        success: true,
        data: await facade.listSessions(filter),
      });
      return;
    }

    const timelineMatch = /^\/api\/v1\/sessions\/([^/]+)\/timeline$/.exec(pathname);
    if (timelineMatch && method === 'GET') {
      const sessionId = decodeURIComponent(timelineMatch[1] ?? '');
      const input = getTimelineInputSchema.parse({
        sessionId,
        limit: Number(url.searchParams.get('limit') ?? 50),
      });
      sendJson(res, 200, {
        success: true,
        data: await facade.getTimeline(input.sessionId, input.limit),
      });
      return;
    }

    const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(pathname);
    if (sessionMatch && method === 'GET') {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? '');
      const status = await facade.getTaskStatus(sessionId);
      if (!status) {
        sendJson(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '会话不存在' } });
        return;
      }
      sendJson(res, 200, { success: true, data: status });
      return;
    }

    const eventsMatch = /^\/api\/v1\/sessions\/([^/]+)\/events$/.exec(pathname);
    const stateMatch = /^\/api\/v1\/tasks\/([^/]+)\/state$/.exec(pathname);
    if ((stateMatch || eventsMatch) && method === 'POST') {
      const sessionId = decodeURIComponent((stateMatch ?? eventsMatch)?.[1] ?? '');
      const body = await readObjectBody(req);
      // 与 MCP update_task_state 共用同一份白名单校验，非法事件返回 INVALID_PARAM 而非 500
      const parsed = updateTaskStateInputSchema.safeParse({
        sessionId,
        event: stateMatch ? body.event : body.eventType,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      if (!parsed.success) {
        sendJson(res, 400, {
          success: false,
          error: { code: 'INVALID_PARAM', message: '不支持的任务标记操作' },
        });
        return;
      }
      const result = await facade.updateTaskState(parsed.data);
      if (!result) {
        sendJson(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '会话不存在' } });
        return;
      }
      sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (pathname === '/api/v1/scan' && method === 'POST') {
      const taskId = await options.triggerScan();
      sendJson(res, 200, { success: true, data: { taskId } });
      return;
    }

    if (pathname === '/api/v1/events' && method === 'GET') {
      const records = await facade.searchEvents({
        eventType: url.searchParams.get('type') ?? undefined,
        toolId: url.searchParams.get('toolId') ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        limit: Number(url.searchParams.get('limit') ?? 200),
      });
      if (url.searchParams.get('download') === '1') {
        const body = JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2);
        setCors(res);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="awm-events.json"',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      sendJson(res, 200, { success: true, data: records });
      return;
    }

    if (pathname === '/api/v1/notifications' && method === 'GET') {
      sendJson(res, 200, { success: true, data: await facade.listNotifications() });
      return;
    }

    if (pathname === '/api/v1/notifications/read' && method === 'POST') {
      const body = await readObjectBody(req);
      await facade.markNotificationRead(
        typeof body.notificationId === 'string' ? body.notificationId : undefined,
      );
      sendJson(res, 200, { success: true, data: { ok: true } });
      return;
    }

    if (pathname === '/api/v1/mcp/snippets' && method === 'GET') {
      sendJson(res, 200, { success: true, data: mcpSnippets(options.getMcpLaunch?.()) });
      return;
    }

    if (pathname === '/api/v1/mcp/validate' && method === 'POST') {
      const launch = options.getMcpLaunch?.();
      if (!launch?.commandReady) throw new RangeError('MCP 桥接尚未构建，请重新构建或安装应用');
      sendJson(res, 200, {
        success: true,
        data: await listStdioMcpTools(launch.command, launch.args),
      });
      return;
    }

    if (pathname === '/api/v1/mcp/servers' && method === 'GET') {
      sendJson(res, 200, { success: true, data: await facade.listMcpServers() });
      return;
    }

    if (pathname === '/api/v1/mcp/servers' && method === 'POST') {
      const body = await readObjectBody(req);
      if (
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.length > 200 ||
        (body.transport !== 'stdio' && body.transport !== 'streamable-http') ||
        (body.args !== undefined &&
          (!Array.isArray(body.args) || body.args.some((item) => typeof item !== 'string'))) ||
        (body.transport === 'stdio' &&
          (typeof body.command !== 'string' || !body.command.trim())) ||
        (body.transport === 'streamable-http' &&
          (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)))
      )
        throw new RangeError('MCP 配置无效');
      const row = await facade.upsertAndConnectMcpServer({
        serverId: typeof body.serverId === 'string' ? body.serverId : undefined,
        name: String(body.name ?? ''),
        transport: body.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        command: typeof body.command === 'string' ? body.command : undefined,
        args: Array.isArray(body.args) ? body.args.map((item) => String(item)) : undefined,
        url: typeof body.url === 'string' ? body.url : undefined,
      });
      sendJson(res, 200, { success: true, data: row });
      return;
    }

    const mcpDelete = /^\/api\/v1\/mcp\/servers\/([^/]+)$/.exec(pathname);
    if (mcpDelete && method === 'DELETE') {
      await facade.removeMcpServer(decodeURIComponent(mcpDelete[1] ?? ''));
      sendJson(res, 200, { success: true, data: { ok: true } });
      return;
    }

    if (pathname === '/api/v1/settings' && method === 'GET') {
      sendJson(res, 200, { success: true, data: options.getSettings() });
      return;
    }

    if (pathname === '/api/v1/settings' && method === 'PUT') {
      const body = await readObjectBody(req);
      sendJson(res, 200, { success: true, data: options.updateSettings(body) });
      return;
    }

    if (pathname === '/api/v1/voice/rules' && method === 'GET') {
      sendJson(res, 200, { success: true, data: await facade.listVoiceRules() });
      return;
    }

    if (pathname === '/api/v1/voice/voices' && method === 'GET') {
      sendJson(res, 200, {
        success: true,
        data: await (options.getNativeVoices ?? listNativeVoices)(),
      });
      return;
    }

    if (pathname === '/api/v1/voice/rules' && method === 'POST') {
      const body = await readObjectBody(req);
      const rule = await facade.setVoiceRule(setVoiceRuleInputSchema.parse(body));
      options.onVoiceRulesChanged?.();
      sendJson(res, 200, { success: true, data: rule });
      return;
    }

    if (pathname === '/api/v1/voice/test' && method === 'POST') {
      const body = await readObjectBody(req);
      const text = typeof body.text === 'string' ? body.text : '这是一条测试播报';
      sendJson(res, 200, { success: true, data: await options.speakTest(text.slice(0, TEST_TEXT_LIMIT)) });
      return;
    }

    if (pathname === '/api/v1/voice/model' && method === 'GET') {
      const kind = modelKind(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('kind'));
      sendJson(res, 200, {
        success: true,
        data: options.getModelState?.(kind) ?? { state: 'missing' as const, kind },
      });
      return;
    }

    if (pathname === '/api/v1/voice/model/download' && method === 'POST') {
      const body = await readObjectBody(req);
      const kind = modelKind(body.kind);
      // 即启即返：大模型下载远超请求超时，进度只经 model.progress SSE 推送。
      options.startModelDownload?.(kind);
      sendJson(res, 200, {
        success: true,
        data: options.getModelState?.(kind) ?? { state: 'missing' as const, kind },
      });
      return;
    }

    if (pathname === '/api/v1/voice/model/cancel' && method === 'POST') {
      const body = await readObjectBody(req);
      const kind = modelKind(body.kind);
      options.cancelModelDownload?.(kind);
      sendJson(res, 200, {
        success: true,
        data: options.getModelState?.(kind) ?? { state: 'missing' as const, kind },
      });
      return;
    }

    sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: `未知端点 ${pathname}` },
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    try {
      server.listen(options.port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    } catch (error) {
      server.off('error', onError);
      reject(error);
    }
  });

  const address = server.address() as AddressInfo;

  return {
    server,
    port: address.port,
    /**
     * 向所有 SSE 客户端广播消息。
     * 单个客户端写入失败（连接已断开）只移除该客户端，不影响其余推送。
     * @param type 事件类型
     * @param data 数据
     */
    broadcast(type: string, data: unknown) {
      const payload = `event: ${type}\ndata: ${JSON.stringify({ type, data, ts: new Date().toISOString() })}\n\n`;
      for (const client of [...clients]) {
        try {
          client.res.write(payload);
        } catch {
          // 客户端已断开：清理死连接，避免下次广播再次抛错
          clients.delete(client);
        }
      }
    },
    async close() {
      for (const client of [...clients]) {
        try {
          client.res.end();
        } catch {
          // 关闭阶段单个客户端失败不中断整体关闭流程
        }
      }
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
