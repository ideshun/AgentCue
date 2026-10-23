/**
 * 事件总线（FLOW-02 主链路第 3 步）。
 * 按 sessionId 分片，同会话串行消费，不同会话互不阻塞。
 * 未处理队列按 occurredAt 补正；已经处理过更晚事件后再到的过期事件记为 anomaly。
 */
import type { EventType, StandardEvent } from '@awm/schema';

/** 事件处理器，可同步或异步 */
export type EventHandler = (event: StandardEvent) => void | Promise<void>;

/**
 * 会话分片事件总线。
 */
export class SessionEventBus {
  /** 各会话的待处理队列 */
  private readonly queues = new Map<string, StandardEvent[]>();

  /** 正在排空的会话，保证同会话串行 */
  private readonly draining = new Set<string>();

  /** 各会话已处理事件的最大 occurredAt */
  private readonly lastOccurredAt = new Map<string, number>();

  /** 事件处理器 */
  private readonly handler: EventHandler;
  private failure: unknown;

  /**
   * @param handler 事件处理器，由上层注入（落库 / 播报 / 推送）
   */
  constructor(handler: EventHandler) {
    this.handler = handler;
  }

  /**
   * 入队一个事件并触发该会话的排空。
   * @param event 标准事件
   */
  enqueue(event: StandardEvent): void {
    const queue = this.queues.get(event.sessionId) ?? [];
    queue.push(event);
    this.queues.set(event.sessionId, queue);
    void this.drain(event.sessionId);
  }

  /**
   * 查询某会话待处理事件数。
   * @param sessionId 会话 id
   * @returns 待处理条数
   */
  pending(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /**
   * 等待所有队列排空，测试与优雅退出使用。
   * @returns 全部处理完成后的 Promise
   */
  async idle(): Promise<void> {
    while (this.draining.size > 0 || this.hasPending()) {
      // 必须让出 macrotask，避免微任务空转饿死测试超时与 drain 续跑
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (this.failure !== undefined) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
  }

  /**
   * 判断是否仍有待处理事件。
   * @returns 是否存在非空队列
   */
  private hasPending(): boolean {
    for (const queue of this.queues.values()) {
      if (queue.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 按 occurredAt 对未处理队列排序，实现乱序补正。
   * @param sessionId 会话 id
   */
  private sortPending(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length <= 1) {
      return;
    }
    queue.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  }

  /**
   * 过期到达、无法插入既有时间线的事件改为 anomaly，保留原类型在 payload。
   * @param event 原始事件
   * @returns 供处理器消费的事件
   */
  private markAnomalyIfLate(event: StandardEvent): StandardEvent {
    const occurred = Date.parse(event.occurredAt);
    const last = this.lastOccurredAt.get(event.sessionId);
    if (last === undefined || Number.isNaN(occurred) || occurred >= last) {
      if (!Number.isNaN(occurred)) {
        this.lastOccurredAt.set(event.sessionId, occurred);
      }
      return event;
    }
    return {
      ...event,
      eventType: 'anomaly' as EventType,
      payload: {
        ...event.payload,
        reason: 'out-of-order',
        originalEventType: event.eventType,
      },
    };
  }

  /**
   * 排空指定会话队列，同会话串行执行。
   * @param sessionId 会话 id
   */
  private async drain(sessionId: string): Promise<void> {
    if (this.draining.has(sessionId)) {
      return;
    }
    this.draining.add(sessionId);
    try {
      // 让同一轮同步入队（例如一次 JSONL 回放）先全部进队，再按 occurredAt 补正
      await Promise.resolve();
      for (;;) {
        this.sortPending(sessionId);
        const next = this.queues.get(sessionId)?.shift();
        if (!next) {
          break;
        }
        try {
          await this.handler(this.markAnomalyIfLate(next));
        } catch (error) {
          // 调用 idle 的宿主接收持久化错误，不产生后台未处理 Promise 拒绝。
          this.failure ??= error;
        }
      }
    } finally {
      this.draining.delete(sessionId);
    }
    if ((this.queues.get(sessionId)?.length ?? 0) > 0) {
      void this.drain(sessionId);
    }
  }
}
