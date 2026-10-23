/**
 * 播报规则引擎（SM-3.1 的 M0 最短链版本）。
 * 按 scope（工具 × 事件）匹配 action：mute / notify / speak。
 * 去抖合并、优先级队列、免打扰判定属 FLOW-04 完整版，M1 实现。
 */
import type { EventType, VoiceAction, VoicePriority } from '@awm/schema';

/** 播报规则 */
export interface VoiceRule {
  /** 规则 id */
  ruleId: string;
  /** 作用工具，null/undefined 表示全部工具 */
  scopeTool?: string | null;
  /** 作用事件类型，`*` 表示全部事件 */
  scopeEvent: string;
  action: VoiceAction;
  /** 播报模板，支持 {tool} {title} {event} 变量 */
  template?: string | null;
  priority?: VoicePriority | null;
}

/** 待判定的迁移信号 */
export interface TransitionSignal {
  /** 稳定事件 id，用于同一提醒只处理一次。 */
  eventId?: string;
  /** 工具 id */
  toolId: string;
  /** 工具显示名；缺省使用工具 id */
  toolName?: string;
  /** 事件类型 */
  eventType: EventType;
  /** 会话 id */
  sessionId: string;
  /** 任务标题 */
  title?: string | null;
}

/** 默认模板：未配置模板时使用 */
export const DEFAULT_TEMPLATE = '{tool} 的「{title}」：{event}。';

/** @description: 没有自定义文本时按事件描述进展，开始或完成不能误报为需要处理。 */
export function defaultTemplateForEvent(eventType: EventType): string {
  const templates: Partial<Record<EventType, string>> = {
    'task.started': '{tool} 开始处理，{title}。',
    'task.waiting_human': '{tool} 有个任务等你确认，{title}。',
    'task.completed': '{tool} 的任务已经完成，{title}。',
    'task.failed': '{tool} 的任务失败了，{title}，请查看。',
    'task.timeout': '{tool} 的确认等待超时了，{title}。',
    'human.responded': '{tool} 继续执行，{title}。',
    'task.retried': '{tool} 正在重试，{title}。',
    'task.archived': '{tool} 的任务已归档，{title}。',
    'task.cancelled': '{tool} 的任务已取消，{title}。',
    'heartbeat.lost': '{tool} 的连接中断了，{title}，请查看。',
    'tool.detected': '{tool} 已被识别，任务 {title}。',
    anomaly: '{tool} 出现异常信号，{title}，请查看。',
  };
  return templates[eventType] ?? DEFAULT_TEMPLATE;
}

/**
 * 匹配规则：精确工具优先于通配，精确事件优先于 `*`。
 * @param rules 规则列表，顺序无关
 * @param signal 迁移信号
 * @returns 命中的规则；无命中返回 null（调用方按默认 speak 处理）
 */
export function matchRule(rules: VoiceRule[], signal: TransitionSignal): VoiceRule | null {
  const candidates = rules.filter((rule) => {
    const toolMatched = !rule.scopeTool || rule.scopeTool === signal.toolId;
    const eventMatched = rule.scopeEvent === '*' || rule.scopeEvent === signal.eventType;
    return toolMatched && eventMatched;
  });
  if (candidates.length === 0) {
    return null;
  }

  /** 规则精确度打分：工具精确 2 分 + 事件精确 1 分 */
  const score = (rule: VoiceRule): number => {
    let value = 0;
    if (rule.scopeTool) {
      value += 2;
    }
    if (rule.scopeEvent !== '*') {
      value += 1;
    }
    return value;
  };

  return candidates.reduce((best, rule) => (score(rule) > score(best) ? rule : best));
}

/**
 * 截断文本，避免播报过长。
 * @param text 原始文本
 * @param max 最大字符数，默认 40（FLOW-04 第 4 步）
 * @returns 截断后的文本
 */
export function truncateText(text: string, max = 40): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= max) {
    return trimmed;
  }
  if (max <= 0) return '';
  return `${characters.slice(0, max - 1).join('')}…`;
}

/** @description: 为无标题任务提供稳定的简短编号，避免不同任务都被称为未命名。 */
export function voiceTaskTitle(signal: TransitionSignal): string {
  const title = signal.title?.trim();
  if (title) return truncateText(title, 40);
  // 与界面使用相同的轻量编号；只用于定位，非安全散列。
  let hash = 2166136261;
  for (let index = 0; index < signal.sessionId.length; index += 1)
    hash = Math.imul(hash ^ signal.sessionId.charCodeAt(index), 16777619);
  return '任务 ' + (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

/**
 * @description: 播报用的短标题。
 * 各工具都不提供真正的会话名，标题来自用户输入的前 40 字；直接读出来可能带代码、链接或半句话。
 * 这里去掉代码块、行内代码、链接和 Markdown 记号，再截到第一个句读，最多 24 字。
 */
export function spokenTaskTitle(signal: TransitionSignal): string {
  const cleaned = (signal.title ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/[*_>~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clause = cleaned.split(/[。！？!?；;]/, 1)[0]?.trim() ?? '';
  const characters = Array.from(clause);
  const label = characters.slice(0, 24).join('').trim();
  if (!label) return voiceTaskTitle({ ...signal, title: null });
  return characters.length > 24 ? `${label}…` : label;
}

/** @description: 播报使用工具显示名，缺省保留可定位的工具 id。 */
export function voiceToolName(signal: TransitionSignal): string {
  return truncateText(signal.toolName?.trim() || signal.toolId, 40);
}

/**
 * 渲染播报模板。
 * @param template 模板字符串，支持 {tool} {title} {event}
 * @param signal 迁移信号
 * @returns 渲染并截断后的文本
 */
export function renderTemplate(template: string, signal: TransitionSignal): string {
  const vars: Record<string, string> = {
    tool: voiceToolName(signal),
    title: voiceTaskTitle(signal),
    event: signal.eventType,
  };
  const rendered = template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
  return truncateText(rendered, 200);
}

/**
 * 判定一个信号应执行的动作。
 * @param rules 规则列表
 * @param signal 迁移信号
 * @returns 动作与待播报文本（仅 speak 有文本）
 */
export function resolveAction(
  rules: VoiceRule[],
  signal: TransitionSignal,
): { action: VoiceAction; text?: string; rule?: VoiceRule } {
  const rule = matchRule(rules, signal);
  if (!rule) {
    return {
      action: 'speak',
      text: renderTemplate(defaultTemplateForEvent(signal.eventType), signal),
    };
  }
  if (rule.action !== 'speak') {
    return { action: rule.action, rule };
  }
  const template = rule.template?.trim()
    ? rule.template
    : defaultTemplateForEvent(signal.eventType);
  return { action: 'speak', text: renderTemplate(template, signal), rule };
}
