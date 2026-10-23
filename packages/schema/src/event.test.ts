/**
 * 标准事件 Schema 契约测试。
 * 覆盖：合法样例、必填校验、枚举收敛、payload 默认值。
 */
import { describe, expect, it } from 'vitest';
import { EVENT_ID_PREFIX, EVENT_TYPES, standardEventSchema } from './event';

/** 构造一个合法事件样例 */
function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `${EVENT_ID_PREFIX}01J9Z8Y7X6W5V4U3T2S1R0Q9P8`,
    sessionId: 'demo-tool:my-project:sess-1',
    toolId: 'demo-tool',
    eventType: 'task.started',
    occurredAt: '2026-10-19T10:00:00.000Z',
    actor: 'tool',
    schemaVersion: 1,
    ...overrides,
  };
}

describe('standardEventSchema', () => {
  it('接受合法事件', () => {
    const result = standardEventSchema.safeParse(makeEvent());
    expect(result.success).toBe(true);
  });

  it('payload 缺省时填充空对象', () => {
    const parsed = standardEventSchema.parse(makeEvent());
    expect(parsed.payload).toEqual({});
  });

  it('拒绝缺少 evt_ 前缀的 eventId', () => {
    const result = standardEventSchema.safeParse(makeEvent({ eventId: 'abc123' }));
    expect(result.success).toBe(false);
  });

  it('拒绝未定义的事件类型', () => {
    const result = standardEventSchema.safeParse(makeEvent({ eventType: 'task.unknown' }));
    expect(result.success).toBe(false);
  });

  it('拒绝非 ISO 8601 时间戳', () => {
    const result = standardEventSchema.safeParse(makeEvent({ occurredAt: '2026/10/19 10:00' }));
    expect(result.success).toBe(false);
  });

  it('拒绝缺失 toolId', () => {
    const event = makeEvent();
    delete (event as Record<string, unknown>).toolId;
    const result = standardEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('所有声明的事件类型均可通过校验', () => {
    for (const eventType of EVENT_TYPES) {
      const result = standardEventSchema.safeParse(makeEvent({ eventType }));
      expect(result.success, `事件类型 ${eventType} 应合法`).toBe(true);
    }
  });

  it('payload 允许扩展字段但保留已知字段类型', () => {
    const parsed = standardEventSchema.parse(
      makeEvent({
        payload: { taskTitle: '重构登录模块', heartbeatSeq: 3, extra: { nested: true } },
      }),
    );
    expect(parsed.payload.taskTitle).toBe('重构登录模块');
    expect(parsed.payload.heartbeatSeq).toBe(3);
    expect(parsed.payload.extra).toEqual({ nested: true });
  });
});
