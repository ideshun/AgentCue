/**
 * 播报优先级队列（SM-3.3、FLOW-04 第 3 步）。
 * 高优（waiting_human / failed / timeout）可打断当前播报，completed 不可打断。
 */
import type { EventType, VoicePriority } from '@awm/schema';

/** 优先级权重，数值越大越优先 */
const PRIORITY_WEIGHT: Record<VoicePriority, number> = {
  low: 0,
  mid: 1,
  high: 2,
};

/**
 * 按事件类型推导默认优先级。
 * @param eventType 事件类型
 * @returns 优先级
 */
export function priorityForEvent(eventType: EventType): VoicePriority {
  if (
    eventType === 'task.waiting_human' ||
    eventType === 'task.failed' ||
    eventType === 'heartbeat.lost' ||
    eventType === 'task.timeout'
  ) {
    return 'high';
  }
  if (eventType === 'task.completed' || eventType === 'task.archived') {
    return 'low';
  }
  return 'mid';
}

/**
 * 判断新播报是否可打断当前播报。
 * @param current 当前播报优先级，无播报时传 undefined
 * @param incoming 新播报优先级
 * @returns 是否可打断
 */
export function canInterrupt(
  current: VoicePriority | undefined,
  incoming: VoicePriority,
): boolean {
  if (current === undefined) {
    return true;
  }
  return PRIORITY_WEIGHT[incoming] > PRIORITY_WEIGHT[current];
}

/** 队列元素需携带优先级 */
export interface Prioritized {
  /** 播报优先级 */
  priority: VoicePriority;
}

/**
 * 优先级队列：出队时返回权重最高的元素，同级先进先出。
 */
export class PriorityQueue<T extends Prioritized> {
  /** 内部存储 */
  private readonly items: T[] = [];

  /**
   * 入队。
   * @param item 队列元素
   */
  enqueue(item: T): void {
    this.items.push(item);
  }

  /**
   * 出队优先级最高的元素。
   * @returns 队首元素，队列为空返回 undefined
   */
  dequeue(): T | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    let bestIndex = 0;
    for (let index = 1; index < this.items.length; index += 1) {
      const current = this.items[index];
      const best = this.items[bestIndex];
      if (current && best && PRIORITY_WEIGHT[current.priority] > PRIORITY_WEIGHT[best.priority]) {
        bestIndex = index;
      }
    }
    return this.items.splice(bestIndex, 1)[0];
  }

  /**
   * 当前队列长度。
   * @returns 长度
   */
  get size(): number {
    return this.items.length;
  }
}
