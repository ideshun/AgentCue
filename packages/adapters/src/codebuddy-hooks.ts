/** CodeBuddy IDE hooks；generation_id 已核验于 IDE 扩展 4.12.39997873 的公开代码。 */
import { createHash } from 'node:crypto';
import { standardEventSchema, type StandardEvent } from '@awm/schema';
import { extractUserTitle } from './user-title';

export type CodeBuddyHookPhase = 'UserPromptSubmit' | 'Stop';

export const codebuddyHookDescriptor = {
  toolId: 'codebuddy',
  mode: 'session',
  supportedModes: ['turn', 'session'],
  phases: ['UserPromptSubmit', 'Stop'],
  configPath: '~/.codebuddy/settings.json',
  documentationUrl: 'https://www.codebuddy.cn/docs/ide/Features/Hooks',
} as const;

export interface CodeBuddyHookOptions {
  phase?: CodeBuddyHookPhase;
  /** 老版 IDE 无 generation_id 时，同一次桥接投递重用接收时间。 */
  receivedAt?: string;
}

export interface CodeBuddyHookSnippetOptions {
  timeoutSeconds?: number;
}

/** @description: 新版 IDE 按请求分轮；缺少逐轮标识时由宿主按会话开始顺序分轮。 */
export function normalizeCodeBuddyHook(
  input: unknown,
  options: CodeBuddyHookOptions = {},
): StandardEvent[] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('CodeBuddy IDE hook 输入必须为 JSON 对象');
  const payload = input as Record<string, unknown>;
  const inputPhase = payload.hook_event_name;
  if (inputPhase !== undefined && typeof inputPhase !== 'string')
    throw new Error('CodeBuddy IDE hook 的 hook_event_name 必须为字符串');
  if (options.phase && inputPhase !== undefined && inputPhase !== options.phase)
    throw new Error('CodeBuddy IDE hook 的显式阶段与 hook_event_name 不一致');
  const phase = options.phase ?? inputPhase;
  if (phase === undefined) throw new Error('CodeBuddy IDE hook 缺少 hook_event_name');
  if (phase !== 'UserPromptSubmit' && phase !== 'Stop') return [];
  if (typeof payload.session_id !== 'string' || !payload.session_id.trim())
    throw new Error('CodeBuddy IDE hook 缺少有效的 session_id');
  const nativeSession = payload.session_id;
  // 官方 IDE 文档尚未列此字段；已安装 4.12.39997873 的公开 out/extension/index.js
  // 在 UserPromptSubmit、Stop 两处均传 generation_id: request.requestId。
  const generationId = typeof payload.generation_id === 'string' && payload.generation_id.trim()
    ? payload.generation_id : undefined;
  const receivedAt = options.receivedAt ?? new Date().toISOString();
  let title: string | undefined;
  if (phase === 'UserPromptSubmit') {
    if (typeof payload.prompt !== 'string')
      throw new Error('CodeBuddy IDE hook 的 prompt 必须为字符串');
    title = extractUserTitle({ type: 'user', message: { role: 'user', content: payload.prompt } });
  }
  const identity = generationId
    ? ['codebuddy-ide-hooks-v2', nativeSession, generationId, phase]
    : ['codebuddy-ide-hooks-v1', nativeSession, phase, receivedAt];
  const sessionId = `codebuddy:hooks:${createHash('sha256').update(nativeSession).digest('hex')}`;
  return [standardEventSchema.parse({
    eventId: `evt_hook_${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    sessionId: generationId
      ? `${sessionId}:turn:${createHash('sha256').update(generationId).digest('hex')}` : sessionId,
    toolId: 'codebuddy',
    eventType: phase === 'UserPromptSubmit' ? 'task.started' : 'task.completed',
    occurredAt: receivedAt,
    actor: 'tool',
    payload: title ? { taskTitle: title } : {},
    schemaVersion: 1,
  })];
}

/** @description: 生成由用户合并的 IDE 配置，不写入客户端文件或增加 Agent 上下文。 */
export function codebuddyHookSnippet(
  command: string,
  options: CodeBuddyHookSnippetOptions = {},
): string {
  if (!command.trim()) throw new Error('CodeBuddy IDE hook 启动命令不能为空');
  const timeout = options.timeoutSeconds ?? 3;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error('CodeBuddy IDE hook timeout 必须为正数秒');
  const entry = { hooks: [{ type: 'command', command, timeout }] };
  return JSON.stringify({ hooks: { UserPromptSubmit: [entry], Stop: [entry] } }, null, 2);
}
