/**
 * 控制 API 客户端（M2）。
 *
 * 桥接进程与桌面主进程是两个独立进程，唯一的通信通道是本机 HTTP 控制 API：
 * - 端口与 token 由主进程写入 runtime.json（0600），每次调用现读，避免应用重启后端口变化
 * - 网络/解析失败统一转成 ENGINE_UNAVAILABLE envelope，不抛异常给协议层
 */
import { APP_DISPLAY_NAME, readRuntimeInfo } from '@awm/core';
import type { Envelope } from '@awm/schema';
import type { ToolName } from './tools';

/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 构造失败 envelope。
 * @param code 错误码
 * @param message 错误描述
 * @param suggestion 修复建议
 * @returns 失败 envelope
 */
function failure(
  code: 'ENGINE_UNAVAILABLE' | 'INVALID_PARAM' | 'NOT_FOUND',
  message: string,
  suggestion?: string,
): Envelope {
  return { success: false, error: { code, message }, suggestion };
}

/**
 * 编码路径片段。
 * @param value 原始值
 * @returns 编码后的字符串
 */
function encodeSegment(value: unknown): string {
  return encodeURIComponent(typeof value === 'string' ? value : String(value ?? ''));
}

/** 控制 API 客户端 */
export class ControlApiClient {
  /**
   * 调用一个 MCP 工具，转发为控制 API 请求。
   * @param tool 工具名
   * @param args 工具入参
   * @returns 控制 API 的 envelope 原样返回
   */
  async invoke(tool: ToolName, args: Record<string, unknown>): Promise<Envelope> {
    const runtime = readRuntimeInfo();
    if (!runtime) {
      return failure(
        'ENGINE_UNAVAILABLE',
        '未找到运行时握手文件，桌面应用可能尚未启动',
        `先启动 ${APP_DISPLAY_NAME}，再重试本次调用`,
      );
    }

    const base = `http://127.0.0.1:${runtime.apiPort}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${runtime.token}`,
      'Content-Type': 'application/json',
    };

    let method = 'GET';
    let pathname = '/api/v1/health';
    let body: string | undefined;

    switch (tool) {
      case 'list_tools':
        pathname = '/api/v1/tools';
        break;
      case 'list_sessions': {
        const params = new URLSearchParams();
        if (typeof args.state === 'string') {
          params.set('state', args.state);
        }
        if (typeof args.toolId === 'string') {
          params.set('toolId', args.toolId);
        }
        if (typeof args.limit === 'number') {
          params.set('limit', String(args.limit));
        }
        pathname = `/api/v1/sessions?${params.toString()}`;
        break;
      }
      case 'get_task_status':
        pathname = `/api/v1/sessions/${encodeSegment(args.sessionId)}`;
        break;
      case 'update_task_state':
        method = 'POST';
        pathname = `/api/v1/tasks/${encodeSegment(args.sessionId)}/state`;
        body = JSON.stringify({ event: args.event, reason: args.reason });
        break;
      case 'set_voice_rule':
        method = 'POST';
        pathname = '/api/v1/voice/rules';
        body = JSON.stringify(args);
        break;
      case 'get_timeline':
        pathname = `/api/v1/sessions/${encodeSegment(args.sessionId)}/timeline?limit=${String(
          args.limit ?? 50,
        )}`;
        break;
      default:
        return failure('INVALID_PARAM', `未知工具：${String(tool)}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${pathname}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      try {
        return JSON.parse(text) as Envelope;
      } catch {
        return failure(
          'ENGINE_UNAVAILABLE',
          `控制 API 返回了非 JSON 响应（HTTP ${response.status}）`,
          '检查桌面应用版本与 MCP 桥接版本是否一致',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        'ENGINE_UNAVAILABLE',
        `无法连接本地控制 API：${message}`,
        `确认 ${APP_DISPLAY_NAME} 正在运行，并检查 127.0.0.1 回环是否被防火墙拦截`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
