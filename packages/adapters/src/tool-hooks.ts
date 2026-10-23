/** Cursor 原生 Agent hooks；契约：https://cursor.com/docs/hooks 。 */
import { createHash } from 'node:crypto';
import { standardEventSchema, type EventType, type StandardEvent } from '@awm/schema';
import { extractUserTitle } from './user-title';

export type CursorHookPhase = 'beforeSubmitPrompt' | 'preToolUse' | 'stop';

export const cursorHookDescriptor = {
  toolId: 'cursor',
  mode: 'turn',
  phases: ['beforeSubmitPrompt', 'preToolUse', 'stop'],
  configPath: '~/.cursor/hooks.json',
  documentationUrl: 'https://cursor.com/docs/hooks',
} as const;

export interface CursorHookOptions {
  phase?: CursorHookPhase;
  /** 由本地桥接进程记录接收时间；不从未声明的 hook 时间字段猜测。 */
  receivedAt?: string;
}

export interface CursorHookSnippetOptions {
  timeoutSeconds?: number;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Cursor hook 缺少有效的 ${key}`);
  return value;
}

/**
 * Cursor Agent 弹出提问框时调用的内部工具。
 * 公开安装包里同时出现工具名 AskQuestion 与调用类型 ask_question_tool_call，
 * 两种写法都只可能指提问框，因此都接受，避免版本差异导致漏报。
 */
const CURSOR_ASK_QUESTION_TOOLS: ReadonlySet<string> = new Set([
  'askquestion',
  'ask_question_tool_call',
]);

/** @description: 只保留任务身份和最多 40 字符的用户标题，身份不依赖时间、正文或重试次数。 */
export function normalizeCursorHook(
  input: unknown,
  options: CursorHookOptions = {},
): StandardEvent[] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Cursor hook 输入必须为 JSON 对象');
  const payload = input as Record<string, unknown>;
  const inputPhase = payload.hook_event_name;
  if (inputPhase !== undefined && typeof inputPhase !== 'string')
    throw new Error('Cursor hook 的 hook_event_name 必须为字符串');
  if (options.phase && inputPhase !== undefined && inputPhase !== options.phase)
    throw new Error('Cursor hook 的显式阶段与 hook_event_name 不一致');
  const phase = options.phase ?? inputPhase;
  if (phase === undefined) throw new Error('Cursor hook 缺少 hook_event_name');
  if (phase !== 'beforeSubmitPrompt' && phase !== 'preToolUse' && phase !== 'stop') return [];
  const conversationId = requiredString(payload, 'conversation_id');
  const generationId = requiredString(payload, 'generation_id');
  let eventType: EventType;
  let title: string | undefined;
  if (phase === 'beforeSubmitPrompt') {
    if (typeof payload.prompt !== 'string') throw new Error('Cursor hook 的 prompt 必须为字符串');
    eventType = 'task.started';
    title = extractUserTitle({ type: 'user', message: { role: 'user', content: payload.prompt } });
  } else if (phase === 'preToolUse') {
    // Cursor 没有专门的"待确认"事件：Agent 弹出提问框时走 AskQuestion 工具，
    // 由 preToolUse 的 tool_name 判定；其余工具调用不是等待用户。
    if (typeof payload.tool_name !== 'string') return [];
    if (!CURSOR_ASK_QUESTION_TOOLS.has(payload.tool_name.trim().toLowerCase())) return [];
    eventType = 'task.waiting_human';
  } else {
    const terminal: Record<string, EventType> = {
      completed: 'task.completed',
      aborted: 'task.cancelled',
      error: 'task.failed',
    };
    if (typeof payload.status !== 'string' || !Object.hasOwn(terminal, payload.status))
      throw new Error('Cursor hook 的 stop.status 必须为 completed、aborted 或 error');
    eventType = terminal[payload.status]!;
  }
  const identity = [
    'cursor-hooks-v1',
    conversationId,
    generationId,
    phase === 'beforeSubmitPrompt' ? 'started' : phase === 'preToolUse' ? 'waiting' : 'terminal',
  ];
  return [standardEventSchema.parse({
    eventId: `evt_hook_${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    sessionId: `cursor:hooks:${encodeURIComponent(conversationId)}:turn:${encodeURIComponent(generationId)}`,
    toolId: 'cursor',
    eventType,
    occurredAt: options.receivedAt ?? new Date().toISOString(),
    actor: 'tool',
    payload: title ? { taskTitle: title } : {},
    schemaVersion: 1,
  })];
}

/** @description: 生成由用户合并的原生 hooks 配置；只观察，不设置 followup_message 或阻止任务。 */
export function cursorHookSnippet(
  command: string,
  options: CursorHookSnippetOptions = {},
): string {
  if (!command.trim()) throw new Error('Cursor hook 启动命令不能为空');
  const timeout = options.timeoutSeconds ?? 3;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error('Cursor hook timeout 必须为正数秒');
  const hook = { command, type: 'command', timeout, failClosed: false };
  // preToolUse 用来识别 Agent 弹提问框（AskQuestion），即"需要你确认"的唯一可用信号。
  return JSON.stringify({
    version: 1,
    hooks: { beforeSubmitPrompt: [hook], preToolUse: [hook], stop: [hook] },
  }, null, 2);
}
