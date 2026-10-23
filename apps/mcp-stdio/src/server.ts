/**
 * MCP Server（stdio transport，JSON-RPC 2.0 按行分隔）。
 *
 * 只实现本产品需要的三个能力面：initialize / tools.list / tools.call，
 * 其余方法按协议返回 -32601。不引入官方 SDK，避免为一个薄桥接层增加运行期依赖；
 * 协议字段严格对齐 MCP 2025-06-18。
 */
import type { Envelope } from '@awm/schema';
import { TOOL_DEFINITIONS, TOOL_NAMES, type ToolName } from './tools';

/** 实现的 MCP 协议版本 */
export const PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
  /** 协议版本 */
  jsonrpc: '2.0';
  /** 请求 id，通知消息无此字段 */
  id?: string | number | null;
  /** 方法名 */
  method: string;
  /** 方法参数 */
  params?: unknown;
}

/** JSON-RPC 错误 */
export interface JsonRpcErrorObject {
  /** 错误码 */
  code: number;
  /** 错误描述 */
  message: string;
  /** 附加信息 */
  data?: unknown;
}

/** JSON-RPC 响应 */
export interface JsonRpcResponse {
  /** 协议版本 */
  jsonrpc: '2.0';
  /** 对应请求 id */
  id: string | number | null;
  /** 成功结果 */
  result?: unknown;
  /** 失败信息 */
  error?: JsonRpcErrorObject;
}

/** 工具调用实现 */
export type ToolInvoker = (tool: ToolName, args: Record<string, unknown>) => Promise<Envelope>;

/** Server 配置 */
export interface McpServerOptions {
  /** 工具调用实现 */
  invoke: ToolInvoker;
  /** 服务版本号 */
  version: string;
}

/**
 * 判断是否为已注册工具名。
 * @param value 待判断值
 * @returns 是否为工具名
 */
function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * 构造错误响应。
 * @param id 请求 id
 * @param code 错误码
 * @param message 错误描述
 * @returns JSON-RPC 响应
 */
function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * 构造成功响应。
 * @param id 请求 id
 * @param result 结果
 * @returns JSON-RPC 响应
 */
function successResponse(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * MCP 服务端。
 */
export class McpServer {
  /** 配置 */
  private readonly options: McpServerOptions;

  /**
   * @param options 配置
   */
  constructor(options: McpServerOptions) {
    this.options = options;
  }

  /**
   * 处理一条 JSON-RPC 消息。
   * @param raw 解析后的消息
   * @returns 响应；通知类消息返回 null（不写回 stdout）
   */
  async handle(raw: unknown): Promise<JsonRpcResponse | null> {
    if (raw === null || typeof raw !== 'object') {
      return errorResponse(null, -32600, '无效请求：消息必须是 JSON 对象');
    }

    const request = raw as Partial<JsonRpcRequest>;
    const id = request.id ?? null;
    const method = request.method;

    if (request.jsonrpc !== '2.0' || typeof method !== 'string') {
      return errorResponse(id, -32600, '无效请求：缺少 jsonrpc 或 method');
    }

    // JSON-RPC 2.0：无 id 成员的消息即通知，不得响应（含 notifications/* 与裸 method）
    if (!('id' in request)) {
      return null;
    }

    if (method === 'initialize') {
      return successResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ai-workflow-monitor', version: this.options.version },
        instructions:
          'AI 编码任务的本地监控台。用 list_sessions 找到需要处理的任务，用 get_task_status 查看卡点，' +
          '必要时用 update_task_state 注入人工响应；所有数据仅在本机流转。',
      });
    }

    if (method === 'ping') {
      return successResponse(id, {});
    }

    if (method === 'tools/list') {
      return successResponse(id, { tools: TOOL_DEFINITIONS });
    }

    if (method === 'tools/call') {
      return this.callTool(id, request.params);
    }

    return errorResponse(id, -32601, `未实现的方法：${method}`);
  }

  /**
   * 执行工具调用。
   * @param id 请求 id
   * @param params 调用参数
   * @returns JSON-RPC 响应
   */
  private async callTool(id: string | number | null, params: unknown): Promise<JsonRpcResponse> {
    if (params === null || typeof params !== 'object') {
      return errorResponse(id, -32602, '无效参数：params 必须是对象');
    }
    const call = params as { name?: unknown; arguments?: unknown };
    if (!isToolName(call.name)) {
      return errorResponse(id, -32602, `未知工具：${String(call.name)}`);
    }
    const args =
      call.arguments !== null && typeof call.arguments === 'object'
        ? (call.arguments as Record<string, unknown>)
        : {};

    const envelope = await this.options.invoke(call.name, args);
    return successResponse(id, {
      content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
      isError: envelope.success === false,
    });
  }
}
