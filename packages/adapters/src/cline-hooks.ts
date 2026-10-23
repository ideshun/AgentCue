/** Cline 4.1.25 HooksAdapter 契约；以已核实的公开扩展代码为准。 */
import { createHash } from 'node:crypto';
import {
  isoTimestampSchema,
  standardEventSchema,
  type EventType,
  type StandardEvent,
} from '@awm/schema';
import { extractUserTitle } from './user-title';

export type ClineHookPhase = 'TaskStart' | 'TaskComplete' | 'TaskCancel';

export const clineHookDescriptor = {
  toolId: 'cline',
  mode: 'session',
  phases: ['TaskStart', 'TaskComplete', 'TaskCancel'],
  configPath: '~/Documents/Cline/Hooks',
  documentationUrl: 'https://github.com/cline/cline/blob/v4.1.25/.clinerules/hooks/README.md',
} as const;

export interface ClineHookOptions {
  phase?: ClineHookPhase;
  /** 仅供统一桥接签名；Cline 原生 timestamp 始终决定 occurredAt。 */
  receivedAt?: string;
}

export interface ClineHookScript {
  path: string;
  content: string;
  executable: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Cline hook 缺少有效的 ${key}`);
  return value;
}

/** @description: 原生毫秒字符串必须能转成标准时间，不用接收时钟代替或伪造发生时间。 */
function nativeTimestamp(value: string): string {
  if (!/^(?:0|[1-9]\d*)$/.test(value))
    throw new Error('Cline hook 的 timestamp 必须为毫秒整数字符串');
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Cline hook 的 timestamp 超出有效范围');
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new Error('Cline hook 的 timestamp 超出有效范围');
  return date.toISOString();
}

/** @description: 只收身份、原生发生时间和用户标题；轮次及事务收据由宿主统一处理。 */
export function normalizeClineHook(
  input: unknown,
  options: ClineHookOptions = {},
): StandardEvent[] {
  const payload = object(input);
  if (!payload) throw new Error('Cline hook 输入必须为 JSON 对象');
  const phase = requiredString(payload, 'hookName');
  if (options.phase !== undefined && options.phase !== phase)
    throw new Error('Cline hook 的显式阶段与 hookName 不一致');
  const taskId = requiredString(payload, 'taskId');
  const timestamp = requiredString(payload, 'timestamp');
  const occurredAt = nativeTimestamp(timestamp);
  if (options.receivedAt !== undefined) isoTimestampSchema.parse(options.receivedAt);
  if (phase !== 'TaskStart' && phase !== 'TaskComplete' && phase !== 'TaskCancel') return [];
  let title: string | undefined;
  if (phase === 'TaskStart') {
    const metadata = object(object(payload.taskStart)?.taskMetadata);
    if (typeof metadata?.initialTask !== 'string')
      throw new Error('Cline hook 的 taskStart.taskMetadata.initialTask 必须为字符串');
    title = extractUserTitle({
      type: 'user',
      message: { role: 'user', content: metadata.initialTask },
    });
  }
  const eventTypes: Record<ClineHookPhase, EventType> = {
    TaskStart: 'task.started',
    TaskComplete: 'task.completed',
    TaskCancel: 'task.cancelled',
  };
  const identity = ['cline-hooks-v1', taskId, phase, timestamp];
  return [
    standardEventSchema.parse({
      eventId: `evt_hook_${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
      sessionId: `cline:hooks:${createHash('sha256').update(taskId).digest('hex')}`,
      toolId: 'cline',
      eventType: eventTypes[phase],
      occurredAt,
      actor: 'tool',
      payload: title ? { taskTitle: title } : {},
      schemaVersion: 1,
    }),
  ];
}

/** @description: 命令由宿主预先进行 shell 参数引用；脚本仅转发 stdin，不阻止或改写任务。 */
export function clineHookScripts(command: string): ClineHookScript[] {
  if (!command.trim()) throw new Error('Cline hook 启动命令不能为空');
  if (/[\r\n\0]/.test(command)) throw new Error('Cline hook 启动命令必须为单行且不含空字符');
  return clineHookDescriptor.phases.map((phase) => ({
    path: `${clineHookDescriptor.configPath}/${phase}`,
    content: `#!/bin/sh\nexec ${command} --hook-phase ${phase}\n`,
    executable: true,
  }));
}
