/** Claude Code 官方 Hooks；契约：https://code.claude.com/docs/en/hooks 。 */
import { createHash } from 'node:crypto';
import {
  isoTimestampSchema,
  standardEventSchema,
  type EventType,
  type StandardEvent,
} from '@awm/schema';
import { extractUserTitle } from '../user-title';

export type ClaudeCodeHookPhase = 'UserPromptSubmit' | 'Stop' | 'Notification';

export const claudeCodeHookDescriptor = {
  toolId: 'claude-code',
  mode: 'turn',
  phases: ['UserPromptSubmit', 'Stop', 'Notification'],
  configPath: '~/.claude/settings.json',
  documentationUrl: 'https://code.claude.com/docs/en/hooks',
} as const;

export interface ClaudeCodeHookOptions {
  phase?: ClaudeCodeHookPhase;
  /** 由本地桥接进程记录接收时间；无 prompt_id 时也用于区分新一轮投递。 */
  receivedAt?: string;
}

export interface ClaudeCodeHookSnippetOptions {
  timeoutSeconds?: number;
}

const PHASES: readonly string[] = claudeCodeHookDescriptor.phases;

function isPhase(value: unknown): value is ClaudeCodeHookPhase {
  return typeof value === 'string' && PHASES.includes(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** @description: 去掉控制字符，把冒号和空白替换为下划线，并按字符截到 128 位，保证会话身份可安全拼接。 */
function sanitizePart(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .map((char) => (char === ':' || /\s/.test(char) ? '_' : char))
    .slice(0, 128)
    .join('');
}

/**
 * @description: 按文件适配器相同的规则拆分 transcript 路径（父目录名 + 去扩展名文件名），
 * 同时兼容 `/` 与 `\`，不依赖当前平台的 path 语义。
 */
function transcriptParts(value: unknown): { project: string; sessionKey: string } | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (/[\\/]$/.test(trimmed)) return undefined;
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment !== '');
  if (segments.length < 2) return undefined;
  const file = segments.at(-1)!;
  const dot = file.lastIndexOf('.');
  const project = sanitizePart(segments.at(-2)!);
  const sessionKey = sanitizePart(dot > 0 ? file.slice(0, dot) : file);
  if (!project || !sessionKey) return undefined;
  return { project, sessionKey };
}

/** @description: 只输出会话身份、阶段和至多 40 字用户标题，绝不保存 transcript、cwd、助手文本或用户身份。 */
export function normalizeClaudeCodeHook(
  input: unknown,
  options: ClaudeCodeHookOptions = {},
): StandardEvent[] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Claude Code hook 输入必须为 JSON 对象');
  const payload = input as Record<string, unknown>;
  const inputPhase = payload.hook_event_name;
  if (inputPhase !== undefined && typeof inputPhase !== 'string')
    throw new Error('Claude Code hook 的 hook_event_name 必须为字符串');
  if (options.phase && inputPhase !== undefined && inputPhase !== options.phase)
    throw new Error('Claude Code hook 的显式阶段与 hook_event_name 不一致');
  const phase = options.phase ?? inputPhase;
  if (phase === undefined) throw new Error('Claude Code hook 缺少 hook_event_name');
  // 未声明的原生事件只忽略，不抛错，避免 Agent 因无关 Hook 失败。
  if (!isPhase(phase)) return [];
  if (typeof payload.session_id !== 'string' || !payload.session_id.trim())
    throw new Error('Claude Code hook 缺少有效的 session_id');
  const nativeSession = payload.session_id;
  let eventType: EventType;
  let title: string | undefined;
  if (phase === 'UserPromptSubmit') {
    if (typeof payload.prompt !== 'string')
      throw new Error('Claude Code hook 的 prompt 必须为字符串');
    eventType = 'task.started';
    title = extractUserTitle({ type: 'user', message: { role: 'user', content: payload.prompt } });
  } else if (phase === 'Stop') {
    // Stop 只表示本轮结束；last_assistant_message 不参与标题或状态。
    eventType = 'task.completed';
  } else {
    // 其余通知类型（空闲、授权结果等）不映射为任务状态。
    if (payload.notification_type !== 'permission_prompt') return [];
    eventType = 'task.waiting_human';
  }
  const receivedAt = options.receivedAt ?? new Date().toISOString();
  isoTimestampSchema.parse(receivedAt);
  const parts = transcriptParts(payload.transcript_path);
  // transcript 可解析时复用文件适配器的 {project}:{sessionKey}，让 Hook 事件落在同一会话记录上。
  const sessionId = parts
    ? `claude-code:${parts.project}:${parts.sessionKey}`
    : `claude-code:hooks:${sha256(nativeSession)}`;
  const promptId =
    typeof payload.prompt_id === 'string' && payload.prompt_id.trim()
      ? payload.prompt_id
      : undefined;
  // 身份只含派生的会话键、轮次标识和阶段；正文、路径、cwd 变化不影响去重。
  const identity = [
    'claude-code-hooks-v1',
    parts?.sessionKey ?? sessionId,
    promptId ?? receivedAt,
    phase,
  ];
  return [
    standardEventSchema.parse({
      eventId: `evt_hook_${sha256(JSON.stringify(identity))}`,
      sessionId,
      toolId: 'claude-code',
      eventType,
      occurredAt: receivedAt,
      actor: 'tool',
      payload: title ? { taskTitle: title } : {},
      schemaVersion: 1,
    }),
  ];
}

/** @description: 生成合并进用户 settings.json 的三个观察事件；不写入客户端文件，也不阻止或改写任务。 */
export function claudeCodeHookSnippet(
  command: string,
  options: ClaudeCodeHookSnippetOptions = {},
): string {
  if (!command.trim()) throw new Error('Claude Code hook 启动命令不能为空');
  // Electron 冷启动实测可超过 3 秒；留足余量，桥接自身仍在 1.75 秒内放行，不会拖住用户。
  const timeout = options.timeoutSeconds ?? 10;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error('Claude Code hook timeout 必须为正数秒');
  const entry = (): { hooks: Array<{ type: 'command'; command: string; timeout: number }> } => ({
    hooks: [{ type: 'command', command, timeout }],
  });
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [entry()],
        Stop: [entry()],
        Notification: [{ matcher: 'permission_prompt', ...entry() }],
      },
    },
    null,
    2,
  );
}
