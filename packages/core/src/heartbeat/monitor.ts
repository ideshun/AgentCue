/**
 * 心跳监控与超时判定（SM-2.3、FLOW-03）。
 * 连续 3 个探测周期无信号 → 判定 heartbeat.lost，由上层发事件并迁移到 timeout。
 */
import type { HeartbeatProbe } from '@awm/schema';

/** 连续无信号的周期阈值 */
export const LOST_CYCLE_THRESHOLD = 3;

/** 单个会话的心跳登记项 */
export interface HeartbeatSource {
  /** 会话 id */
  sessionId: string;
  /** 探测间隔（秒） */
  intervalSec: number;
  /** 探测方式 */
  probe: HeartbeatProbe;
  /** 最近一次收到信号的时间戳（毫秒） */
  lastSignalAt: number;
}

/**
 * 心跳监控器。
 * 时钟可注入，便于单测使用可控时间。
 */
export class HeartbeatMonitor {
  /** 登记的会话 */
  private readonly sources = new Map<string, HeartbeatSource>();

  /** 当前时间函数 */
  private readonly now: () => number;

  /**
   * @param now 返回当前时间戳（毫秒）的函数，默认 Date.now
   */
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * 登记一个会话的心跳。
   * @param input 会话与探测配置
   */
  register(input: { sessionId: string; intervalSec: number; probe: HeartbeatProbe }): void {
    this.sources.set(input.sessionId, {
      sessionId: input.sessionId,
      intervalSec: input.intervalSec,
      probe: input.probe,
      lastSignalAt: this.now(),
    });
  }

  /**
   * 标记一个会话收到信号。
   * @param sessionId 会话 id
   */
  markAlive(sessionId: string): void {
    const source = this.sources.get(sessionId);
    if (source) {
      source.lastSignalAt = this.now();
    }
  }

  /**
   * 取消登记。
   * @param sessionId 会话 id
   */
  unregister(sessionId: string): void {
    this.sources.delete(sessionId);
  }

  /**
   * 判断会话是否已登记。
   * 用于「已登记就不再重置计时」的场景，避免每次轮询都把 lastSignalAt 刷新导致永不判定丢失。
   * @param sessionId 会话 id
   * @returns 是否已登记
   */
  has(sessionId: string): boolean {
    return this.sources.has(sessionId);
  }

  /**
   * 扫描一轮，收集超过阈值的会话。
   * 判定后自动取消登记，避免重复上报。
   * @returns 判定为心跳丢失的会话 id 列表
   */
  collectLost(): string[] {
    const current = this.now();
    const lost: string[] = [];
    for (const source of [...this.sources.values()]) {
      const silentMs = current - source.lastSignalAt;
      if (silentMs >= source.intervalSec * 1_000 * LOST_CYCLE_THRESHOLD) {
        lost.push(source.sessionId);
        this.sources.delete(source.sessionId);
      }
    }
    return lost;
  }

  /**
   * 当前登记的会话数。
   * @returns 数量
   */
  get size(): number {
    return this.sources.size;
  }
}
