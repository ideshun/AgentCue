/**
 * 会话 JSONL 提取器。
 *
 * 把原始行按 manifest.eventMapping 映射为标准事件。
 * 事件规则来自 manifest；Codex 的公开 turn_id 用于区分同一文件中的任务轮次。
 * 匹配行 type、嵌套 payload.type，以及权限请求的 toolName。
 */
import {
  standardEventSchema,
  type AdapterManifest,
  type EventType,
  type SourceTaskContext,
  type StandardEvent,
} from '@awm/schema';
import { createHash } from 'node:crypto';
import { extractUserTitle } from '../user-title';

export type { SourceTaskContext } from '@awm/schema';

/** 语义键 → 标准事件类型，键对应 manifest.eventMapping 的键 */
const SEMANTIC_TO_EVENT_TYPE: Record<string, EventType> = {
  started: 'task.started',
  waiting_human: 'task.waiting_human',
  completed: 'task.completed',
  failed: 'task.failed',
  cancelled: 'task.cancelled',
};

/** 会话文件的原始行 */
export interface RawLine {
  /** 行类型，如 user / assistant / result / permission_request */
  type?: string;
  /** 会话标识 */
  sessionId?: string;
  /** 时间戳 */
  timestamp?: string;
  /** 结果是否出错 */
  is_error?: boolean;
  /** 消息体 */
  message?: unknown;
  /** 工具名（权限请求场景） */
  toolName?: string;
  /** 其余字段原样保留 */
  [key: string]: unknown;
}

/** 提取上下文：决定 sessionId 的三段拼装 */
export interface ExtractContext {
  /** 适配器 id */
  toolId: string;
  /** 项目标识 */
  project: string;
  /** 会话键，通常取文件名（去扩展名） */
  sessionKey: string;
  sourcePath?: string;
  title?: string | null;
  context?: SourceTaskContext | null;
}

export interface ExtractedSourceBatch {
  events: StandardEvent[];
  context: SourceTaskContext;
  titles: Array<{ sessionId: string; title: string | null }>;
}

/** 解析结果 */
export interface ParseResult {
  /** 成功解析的行 */
  rows: RawLine[];
  /** 解析失败的行号（从 1 开始） */
  badLineNumbers: number[];
}

/**
 * 解析 JSONL 文本，坏行跳过并记录行号。
 * @param text 文件内容
 * @returns 解析结果
 */
export function parseJsonl(text: string): ParseResult {
  const rows: RawLine[] = [];
  const badLineNumbers: number[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '') {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        badLineNumbers.push(index + 1);
        continue;
      }
      rows.push(value as RawLine);
    } catch {
      badLineNumbers.push(index + 1);
    }
  }
  return { rows, badLineNumbers };
}

/**
 * 生成事件 id。
 * 与 core/normalize 的 createEventId 算法一致；此处不收敛为单处实现是依赖方向约束：
 * adapters 不得依赖 core（core 是上层消费者），重复的代价仅是一行算法，可接受。
 * @returns 形如 evt_<base36> 的 id
 */
function createEventId(source: string, eventType: EventType, row: RawLine): string {
  return `evt_${createHash('sha256')
    .update(JSON.stringify([source, eventType, row]))
    .digest('hex')}`;
}

/**
 * 将时间戳规范为 ISO 8601。
 * @param value 原始时间戳
 * @returns 合法 ISO 8601 字符串，无法解析时返回当前时间
 */
function toIsoTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

/**
 * 读取嵌套 payload.type（部分 JSONL 会话把语义放在信封内，行 type 只是 event_msg）。
 * @param row 原始行
 * @returns payload.type，没有则 undefined
 */
function payloadType(row: RawLine): string | undefined {
  const payload = row.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const type = (payload as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * 判断原始行是否携带错误信号。
 * @param row 原始行
 * @returns 是否为错误
 */
function rowIndicatesError(row: RawLine): boolean {
  if (row.is_error === true) {
    return true;
  }
  const payload = row.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const error = (payload as { error?: unknown }).error;
  return error !== undefined && error !== null && error !== false && error !== '';
}

/**
 * 判断原始行是否命中一条映射规则。
 * @param row 原始行
 * @param rule 映射规则
 * @returns 是否命中
 */
function matchesRule(
  row: RawLine,
  rule: { match: string; ok?: boolean },
  turnAliases: boolean,
): boolean {
  const type = payloadType(row);
  const alias = turnAliases &&
    ((rule.match === 'task_started' && type === 'turn_started') ||
      (rule.match === 'task_complete' && type === 'turn_complete'));
  // 主匹配：行 type、嵌套 payload.type、或权限请求的工具名
  const hit =
    row.type === rule.match || row.toolName === rule.match || type === rule.match || alias;
  if (!hit) {
    return false;
  }
  if (rule.ok === undefined) {
    return true;
  }
  const isError = rowIndicatesError(row);
  return rule.ok ? !isError : isError;
}

/**
 * 从整份会话中提取任务标题：取第一条带文本的用户消息。
 * 事件本身可能来自权限请求行（无 message 字段），因此需要会话级兜底标题。
 * @param rows 全部原始行
 * @returns 标题，取不到返回 undefined
 */
export function extractSessionTitle(rows: RawLine[]): string | undefined {
  for (const row of rows) {
    const title = extractUserTitle(row);
    if (title) {
      return title;
    }
  }
  return undefined;
}

/**
 * 按 manifest 映射提取标准事件。
 * @param rows 原始行
 * @param manifest 适配器 manifest
 * @param ctx 提取上下文
 * @returns 标准事件数组，按原始行顺序
 */
export function extractEvents(
  rows: RawLine[],
  manifest: AdapterManifest,
  ctx: ExtractContext,
): StandardEvent[] {
  return extractSourceBatch(rows, manifest, ctx).events;
}

/**
 * @description: 按公开 SessionSource 的序列化结构识别内部任务，不检查正文或 Display 字符串。
 * Simple 变体序列化成单个键：internal: "<kind>" 或 subagent: "<kind>"。
 * subagent.thread_spawn 则序列化成 subagent: { thread_spawn: { parent_thread_id, depth, … } }；
 * 子 Agent 的每一轮都会写成独立 rollout 并产生开始/完成，正是「分配子 Agent 也播报」的来源，
 * 因此对象值同样算子 Agent。多键对象不是 serializer 产物，保持不猜。
 */
function internalSource(rows: RawLine[]): boolean | undefined {
  const metadata = rows.find((row) => row.type === 'session_meta');
  if (!metadata) return undefined;
  const payload = metadata.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const source = (payload as Record<string, unknown>).source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const value = source as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const [key] = keys;
  const kind = value[key];
  if (key === 'internal') return typeof kind === 'string';
  if (key !== 'subagent') return false;
  if (typeof kind === 'string') return true;
  // ThreadSpawn 是 struct 变体、Other 是 newtype 变体，serde 序列化成单键对象；
  // 其余形状（例如 review: {}）不是 serializer 产物，不猜。
  if (!kind || typeof kind !== 'object' || Array.isArray(kind)) return false;
  const variants = Object.keys(kind);
  if (variants.length !== 1) return false;
  const [variant] = variants;
  const inner = (kind as Record<string, unknown>)[variant];
  if (variant === 'thread_spawn') return typeof inner === 'object' && inner !== null;
  if (variant === 'other') return typeof inner === 'string';
  return false;
}

/** @description: 保留来源任务上下文，使同一轮跨增量批次仍使用独立身份与真实用户标题。 */
export function extractSourceBatch(
  rows: RawLine[],
  manifest: AdapterManifest,
  ctx: ExtractContext,
): ExtractedSourceBatch {
  const base = `${ctx.toolId}:${ctx.project}:${ctx.sessionKey}`;
  // 任务身份粒度由 manifest 声明（如 Codex 每轮 turn 独立成任务），不按工具 id 特判。
  const byTurn = manifest.sessionSource.identityMode === 'turn';
  const events: StandardEvent[] = [];
  let context: SourceTaskContext = { ...ctx.context };
  if (byTurn && context.excluded === undefined) {
    const excluded = internalSource(rows);
    if (excluded !== undefined) context.excluded = excluded;
  }
  if (context.excluded) return { events: [], titles: [], context: { excluded: true } };
  const titles = new Map<string, string | null>();
  const idFor = (taskId?: string): string => (taskId ? `${base}:turn:${taskId}` : base);
  const knownTitle = (taskId?: string): string | null =>
    taskId
      ? context.taskId === taskId ? context.title ?? null : null
      : ctx.title ?? (!context.taskId ? context.title : null) ?? null;
  const encounter = (sessionId: string, title: string | null): void => {
    if (!titles.has(sessionId)) titles.set(sessionId, title);
  };

  for (const row of rows) {
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown>
      : undefined;
    const type = payloadType(row);
    const boundary = byTurn && row.type === 'event_msg' &&
      ['task_started', 'turn_started', 'task_complete', 'turn_complete', 'turn_aborted'].includes(type ?? '');
    const taskId = boundary && typeof payload?.turn_id === 'string' && payload.turn_id.trim()
      ? payload.turn_id
      : undefined;
    const starts = boundary && (type === 'task_started' || type === 'turn_started');
    if (taskId && starts && taskId !== context.taskId) {
      context = {
        ...(context.excluded === undefined ? {} : { excluded: context.excluded }),
        taskId,
        title: context.pendingTitle ?? null,
        closed: false,
      };
    } else if (boundary && !taskId && !context.taskId && starts) {
      context.closed = false;
      delete context.pendingTitle;
    }
    const title = extractUserTitle(row);
    if (title) {
      if (byTurn && context.closed) {
        context.pendingTitle ??= title;
      } else if (byTurn && !context.taskId) {
        context.title ??= title;
        context.pendingTitle ??= title;
        encounter(base, context.title);
      } else {
        context.title ??= title;
        const sessionId = byTurn ? idFor(context.taskId) : base;
        encounter(sessionId, context.title ?? title);
        if (titles.get(sessionId) === null) titles.set(sessionId, context.title ?? title);
      }
    }
    for (const [semantic, rule] of Object.entries(manifest.eventMapping)) {
      const eventType = SEMANTIC_TO_EVENT_TYPE[semantic];
      if (!eventType) {
        continue;
      }
      if (!matchesRule(row, rule, byTurn)) {
        continue;
      }
      const sessionId = byTurn ? idFor(taskId) : base;
      encounter(sessionId, knownTitle(byTurn ? taskId : undefined));
      events.push(
        standardEventSchema.parse({
          eventId: createEventId(`${ctx.sourcePath ?? ''}:${sessionId}`, eventType, row),
          sessionId,
          toolId: ctx.toolId,
          eventType,
          occurredAt: toIsoTimestamp(row.timestamp),
          actor: 'tool',
          payload: {
            taskTitle: titles.get(sessionId) ?? undefined,
            reason: rule.reason,
          },
          schemaVersion: 1,
        }),
      );
    }
    if (taskId && boundary && !starts && taskId === context.taskId) context.closed = true;
    else if (boundary && !taskId && !context.taskId && !starts) {
      context.closed = true;
      delete context.pendingTitle;
    }
  }

  for (const event of events) event.payload.taskTitle = titles.get(event.sessionId) ?? undefined;
  return {
    events,
    context,
    titles: [...titles].map(([sessionId, title]) => ({ sessionId, title })),
  };
}
