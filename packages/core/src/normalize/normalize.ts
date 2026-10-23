/**
 * 事件归一化（SM-2.1）。
 * 适配器原始信号 → 标准事件，统一在此构造并校验，避免各适配器自造结构。
 */
import {
  EVENT_ID_PREFIX,
  standardEventSchema,
  type EventActor,
  type EventPayload,
  type EventType,
  type StandardEvent,
} from '@awm/schema';

/**
 * 生成事件 id。
 * 不引入 ULID 依赖，采用时间戳 + 随机后缀；如需跨机唯一再升级为 ULID。
 * @param now 时间基准，默认当前时间
 * @returns 形如 evt_<base36> 的事件 id
 */
export function createEventId(now: Date = new Date()): string {
  const timePart = now.getTime().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${EVENT_ID_PREFIX}${timePart}${randomPart}`;
}

/** 构造标准事件的入参 */
export interface CreateEventInput {
  /** 会话 id，格式 {toolId}:{project}:{sessKey} */
  sessionId: string;
  /** 适配器 id */
  toolId: string;
  eventType: EventType;
  /** 发生时间，默认当前时间 */
  occurredAt?: string;
  /** 发起方，默认 tool */
  actor?: EventActor;
  /** 事件载荷 */
  payload?: EventPayload;
}

/**
 * 构造并校验标准事件。
 * @param input 构造入参
 * @returns 通过校验的标准事件
 * @throws 字段不合法时抛出 Zod 错误
 */
export function createStandardEvent(input: CreateEventInput): StandardEvent {
  return standardEventSchema.parse({
    eventId: createEventId(),
    sessionId: input.sessionId,
    toolId: input.toolId,
    eventType: input.eventType,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    actor: input.actor ?? 'tool',
    payload: input.payload ?? {},
    schemaVersion: 1,
  });
}

/**
 * 校验外部输入是否为合法标准事件。
 * @param raw 待校验数据
 * @returns 校验通过的标准事件
 * @throws 不合法时抛出，调用方应降级为 anomaly 事件
 */
export function parseStandardEvent(raw: unknown): StandardEvent {
  return standardEventSchema.parse(raw);
}

/**
 * 构造异常事件：原始信号无法归一时使用，仅用于通知，不参与状态迁移。
 * @param toolId 适配器 id
 * @param sessionId 会话 id
 * @param reason 异常原因
 * @returns 标准事件（eventType 为 anomaly）
 */
export function createAnomalyEvent(toolId: string, sessionId: string, reason: string): StandardEvent {
  return createStandardEvent({
    sessionId,
    toolId,
    eventType: 'anomaly',
    actor: 'system',
    payload: { reason },
  });
}
