/**
 * 免打扰判定（FLOW-04 第 6 步）。
 * 全局静音不可突破，waiting_human 例外只适用于免打扰时段。
 */
import type { EventType } from '@awm/schema';

/** 免打扰时段 */
export interface QuietRange {
  /** 起始 HH:mm */
  from: string;
  /** 结束 HH:mm */
  to: string;
}

/** 免打扰判定入参 */
export interface QuietInput {
  /** 全局静音 */
  globalMute: boolean;
  /** 免打扰时段列表 */
  ranges: QuietRange[];
  /** waiting_human 是否突破免打扰 */
  waitingHumanOverride: boolean;
  /** 当前事件类型 */
  eventType: EventType;
  /** 判定时刻 */
  now: Date;
}

/**
 * 把 HH:mm 转为当日分钟数。
 * @param value HH:mm
 * @returns 分钟数，格式非法返回 null
 */
export function toMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

/**
 * 判断时刻是否落在时段内，支持跨天（如 22:30 → 08:30）。
 * @param currentMinutes 当前时刻的分钟数
 * @param range 时段
 * @returns 是否在时段内
 */
export function inRange(currentMinutes: number, range: QuietRange): boolean {
  const from = toMinutes(range.from);
  const to = toMinutes(range.to);
  if (from === null || to === null) {
    return false;
  }
  if (from <= to) {
    return currentMinutes >= from && currentMinutes <= to;
  }
  // 跨天：落在 from→24:00 或 00:00→to
  return currentMinutes >= from || currentMinutes <= to;
}

/**
 * 判定是否处于免打扰。
 * @param input 判定入参
 * @returns 是否免打扰（true 表示不出声）
 */
export function isQuiet(input: QuietInput): boolean {
  if (input.globalMute) {
    return true;
  }
  if (input.waitingHumanOverride && input.eventType === 'task.waiting_human') {
    return false;
  }
  const currentMinutes = input.now.getHours() * 60 + input.now.getMinutes();
  return input.ranges.some((range) => inRange(currentMinutes, range));
}
