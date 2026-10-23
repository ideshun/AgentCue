/**
 * 播报去抖合并器（SM-3.2、FLOW-04 第 2 步）。
 * - 同一稳定事件 ID 在服务生命周期内只接受一次
 * - 同会话同类事件 30s 内去重
 * - 同工具 5 分钟窗口内 ≥3 个 completed 合并为一条
 * - 全局 2s 冷却
 */
import type { EventType } from '@awm/schema';

/** 同会话同类去重窗口 */
export const DEDUPE_WINDOW_MS = 30_000;

/** 同类合并统计窗口 */
export const MERGE_WINDOW_MS = 300_000;

/** 全局冷却时长 */
export const GLOBAL_COOLDOWN_MS = 2_000;

/** 触发合并的同类事件数量 */
export const MERGE_THRESHOLD = 3;

/** 待判定的播报候选 */
export interface EmitCandidate {
  /** 稳定事件 id；兼容没有事件身份的调用方。 */
  eventId?: string;
  /** 会话 id */
  sessionId: string;
  /** 工具 id */
  toolId: string;
  /** 事件类型 */
  eventType: EventType;
  /** 候选时间戳（毫秒） */
  at: number;
}

/** 去抖判定结果 */
export interface DebounceDecision {
  /** 是否允许播报 */
  emit: boolean;
  /** 判定原因，便于日志与排障 */
  reason: 'ok' | 'cooldown' | 'dedupe' | 'merged';
  /** 合并播报时的数量 */
  mergedCount?: number;
  /** 冷却剩余时间；调用方可有界延后而非丢弃。 */
  retryAfterMs?: number;
}

/**
 * 去抖合并器，按会话与工具维度统计。
 */
export class DebounceMerger {
  /** 已接受的事件身份；播放完成、冷却结束或设置变更都不释放。 */
  private readonly acceptedEventIds = new Set<string>();

  /** `sessionId|eventType` → 上次播报时间 */
  private readonly lastEmit = new Map<string, number>();

  /** `toolId|eventType` → 窗口内的事件时间列表 */
  private readonly buckets = new Map<string, number[]>();

  /** 上次全局播报时间 */
  private lastGlobalEmitAt = -Infinity;

  /**
   * 判定一条候选是否应播报。
   * @param candidate 播报候选
   * @returns 判定结果
   */
  decide(candidate: EmitCandidate, options: { bypassCooldown?: boolean } = {}): DebounceDecision {
    const { eventId, sessionId, toolId, eventType, at } = candidate;
    if (eventId && this.acceptedEventIds.has(eventId)) return { emit: false, reason: 'dedupe' };

    const dedupeKey = `${sessionId}|${eventType}`;
    const lastAt = this.lastEmit.get(dedupeKey);
    if (lastAt !== undefined && at - lastAt < DEDUPE_WINDOW_MS) {
      return { emit: false, reason: 'dedupe' };
    }

    if (!options.bypassCooldown && at - this.lastGlobalEmitAt < GLOBAL_COOLDOWN_MS) {
      return {
        emit: false,
        reason: 'cooldown',
        retryAfterMs: GLOBAL_COOLDOWN_MS - (at - this.lastGlobalEmitAt),
      };
    }

    const bucketKey = `${toolId}|${eventType}`;
    const bucket = (this.buckets.get(bucketKey) ?? []).filter((ts) => at - ts < MERGE_WINDOW_MS);
    bucket.push(at);
    if (eventId) this.acceptedEventIds.add(eventId);

    if (bucket.length >= MERGE_THRESHOLD) {
      this.buckets.set(bucketKey, []);
      this.lastEmit.set(dedupeKey, at);
      this.lastGlobalEmitAt = at;
      return { emit: true, reason: 'merged', mergedCount: bucket.length };
    }

    this.buckets.set(bucketKey, bucket);
    this.lastEmit.set(dedupeKey, at);
    this.lastGlobalEmitAt = at;
    return { emit: true, reason: 'ok' };
  }
}
