/**
 * 迁移矩阵单测（M0 门禁：迁移矩阵 100% 分支覆盖）。
 * 覆盖 7 状态 × 12 事件的全组合，逐项断言合法/非法。
 */
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, TASK_STATES, type EventType, type TaskState } from '@awm/schema';
import {
  IllegalTransitionError,
  isLegalTransition,
  requireTransition,
  resolveTransition,
} from './transition-table';

/** 合法迁移集合，用于反查非法组合 */
const LEGAL: ReadonlyArray<readonly [TaskState, EventType, TaskState]> = [
  ['idle', 'task.started', 'running'],
  ['running', 'task.waiting_human', 'waiting_human'],
  ['running', 'task.failed', 'failed'],
  ['running', 'task.completed', 'completed'],
  ['running', 'task.cancelled', 'cancelled'],
  ['running', 'heartbeat.lost', 'timeout'],
  ['waiting_human', 'human.responded', 'running'],
  ['waiting_human', 'task.timeout', 'timeout'],
  ['waiting_human', 'task.cancelled', 'cancelled'],
  ['waiting_human', 'heartbeat.lost', 'timeout'],
  ['failed', 'task.retried', 'running'],
  ['failed', 'task.archived', 'idle'],
  ['timeout', 'task.retried', 'running'],
  ['timeout', 'task.archived', 'idle'],
  ['completed', 'task.archived', 'idle'],
  ['cancelled', 'task.archived', 'idle'],
] as const;

/** 构造合法迁移的 Map 便于查询 */
const legalMap = new Map<string, TaskState>(
  LEGAL.map(([state, event, next]) => [`${state}|${event}`, next]),
);

describe('TRANSITION_TABLE', () => {
  it('每条合法迁移都能解析到目标状态', () => {
    for (const [state, event, next] of LEGAL) {
      expect(resolveTransition(state, event), `${state} + ${event}`).toBe(next);
      expect(isLegalTransition(state, event)).toBe(true);
    }
  });

  it('全组合遍历：未在合法集合内的一律判非法', () => {
    let legalCount = 0;
    for (const state of TASK_STATES) {
      for (const event of EVENT_TYPES) {
        const expected = legalMap.get(`${state}|${event}`);
        const actual = resolveTransition(state, event);
        if (expected === undefined) {
          expect(actual, `${state} + ${event} 应为非法`).toBeNull();
        } else {
          expect(actual, `${state} + ${event} 应为 ${expected}`).toBe(expected);
          legalCount += 1;
        }
      }
    }
    // 合法迁移总数应与声明一致，防止表里多出非法边
    expect(legalCount).toBe(LEGAL.length);
  });

  it('回跳防护：completed 不接受 task.started', () => {
    expect(resolveTransition('completed', 'task.started')).toBeNull();
    expect(resolveTransition('completed', 'task.retried')).toBeNull();
  });

  it('回跳防护：cancelled 不接受 task.started', () => {
    expect(resolveTransition('cancelled', 'task.started')).toBeNull();
  });

  it('requireTransition 非法时抛出带错误码的异常', () => {
    try {
      requireTransition('completed', 'task.started');
      expect.unreachable('应抛出异常');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      const illegal = error as IllegalTransitionError;
      expect(illegal.code).toBe('ILLEGAL_TRANSITION');
      expect(illegal.prevState).toBe('completed');
      expect(illegal.eventType).toBe('task.started');
    }
  });

  it('failed 与 timeout 均可显式重试回到 running', () => {
    expect(requireTransition('failed', 'task.retried')).toBe('running');
    expect(requireTransition('timeout', 'task.retried')).toBe('running');
  });
});
