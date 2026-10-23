/**
 * 自动通知/播报与试听的生命周期。规则静音优先，通知和语音均经过去抖。
 */
import type { EventType, Settings, VoicePriority } from '@awm/schema';
import {
  DebounceMerger,
  GLOBAL_COOLDOWN_MS,
  canInterrupt,
  defaultTemplateForEvent,
  isQuiet,
  normalizeForSpeech,
  priorityForEvent,
  renderTemplate,
  resolveAction,
  spokenTaskTitle,
  truncateText,
  voiceTaskTitle,
  voiceToolName,
  PriorityQueue,
  type SpeakResult,
  type TransitionSignal,
  type TtsChain,
  type VoiceRule,
} from '@awm/core';
import { listVoiceRules, type AppDb, type VoiceRuleRow } from '@awm/store';

export interface VoiceNotice {
  title: string;
  body: string;
  attention: boolean;
  reason: string;
  sessionId?: string;
}

export interface VoiceOutcome {
  action: 'mute' | 'notify' | 'speak' | 'skipped';
  reason?: string;
  text?: string;
  speak?: SpeakResult;
}

interface QueuedSpeak {
  priority: VoicePriority;
  text: string;
  signal: TransitionSignal;
  notBefore?: number;
}

export interface VoiceServiceDeps {
  db: AppDb;
  getChain: () => TtsChain;
  getSettings: () => Settings;
  onNotify?: (notice: VoiceNotice) => void;
}

/** @description: 把持久化规则转换为规则引擎的输入。 */
function toVoiceRule(row: VoiceRuleRow): VoiceRule {
  return {
    ruleId: row.ruleId,
    scopeTool: row.scopeTool,
    scopeEvent: row.scopeEvent,
    action: row.action as VoiceRule['action'],
    template: row.template,
    priority: row.priority as VoiceRule['priority'],
  };
}

/** @description: 自定义文案保留原意，最终播报只补缺失的工具或任务标识。 */
function withTaskIdentity(text: string, signal: TransitionSignal): string {
  const tool = voiceToolName(signal);
  const title = voiceTaskTitle(signal);
  const parts = [
    !text.includes(tool) ? tool : '',
    !text.includes(title) ? `「${title}」` : '',
  ].filter(Boolean);
  if (!parts.length) return text;
  const prefix = parts.join(' · ') + '，';
  if (prefix.length + text.length <= 200) return prefix + text;
  const identity = `${tool} · 「${title}」，`;
  return identity + truncateText(text, 200 - identity.length);
}

/** 播报范围：'all' 表示不筛事件，后续仍由 AUTOMATIC_SPEECH_EVENTS 决定能否出声。 */
function inBroadcastScope(
  scope: Settings['voice']['scope'],
  eventType: EventType,
): boolean {
  if (scope === 'all') return true;
  if (scope === 'milestones')
    return (
      eventType === 'task.waiting_human' ||
      eventType === 'task.started' ||
      eventType === 'task.completed'
    );
  return eventType === 'task.waiting_human';
}

/** 自动语音只覆盖用户关心的三种任务阶段，其他阶段保留通知。 */
const AUTOMATIC_SPEECH_EVENTS: ReadonlySet<EventType> = new Set([
  'task.started',
  'task.waiting_human',
  'task.completed',
]);

export class VoiceService {
  private readonly debouncer = new DebounceMerger();
  /** 超出播报范围的提醒单独去抖，不污染出声队列的窗口。 */
  private readonly notifyDebouncer = new DebounceMerger();
  private readonly queue = new PriorityQueue<QueuedSpeak>();
  private speaking: QueuedSpeak | null = null;
  private previewing = false;
  private generation = 0;
  private activeChain: TtsChain | null = null;
  private playback: Promise<SpeakResult> | null = null;
  private playbackBarrier: Promise<void> = Promise.resolve();
  private queueWakeTimer: NodeJS.Timeout | undefined;
  private queueWakeAt = Infinity;
  private stopped = false;
  private readonly deps: VoiceServiceDeps;

  constructor(deps: VoiceServiceDeps) {
    this.deps = deps;
  }

  /** @description: 规则静音无输出；其他动作先去抖，再决定通知或出声。 */
  async announce(signal: TransitionSignal, now: Date = new Date()): Promise<VoiceOutcome> {
    if (this.stopped) return { action: 'skipped', reason: 'service-stopped' };
    const resolved = resolveAction(this.rules(), signal);
    if (resolved.action === 'mute') return { action: 'mute', reason: resolved.rule?.ruleId };
    const scope = this.deps.getSettings().voice.scope;
    const inScope = inBroadcastScope(scope, signal.eventType);
    // 超出播报范围的事件只进通知：用独立去抖器，避免同一轮的开始/完成反复弹通知，
    // 同时不占用播报去抖窗口——紧随其后的待确认必须仍能出声。
    if (!inScope) {
      const decision = this.notifyDebouncer.decide(
        { ...signal, at: now.getTime() },
        { bypassCooldown: true },
      );
      if (!decision.emit) return { action: 'skipped', reason: decision.reason };
      this.notify(signal, 'out-of-scope');
      return { action: 'notify', reason: 'out-of-scope' };
    }
    const candidate = { ...signal, at: now.getTime() };
    let decision = this.debouncer.decide(candidate);
    let delay = 0;
    if (!decision.emit && decision.reason === 'cooldown') {
      delay = Math.max(
        0,
        Math.min(GLOBAL_COOLDOWN_MS, decision.retryAfterMs ?? GLOBAL_COOLDOWN_MS),
      );
      // 接受并记录新候选，避免等待期间的重复事件再次入队。
      decision = this.debouncer.decide(candidate, { bypassCooldown: true });
    }
    if (!decision.emit) return { action: 'skipped', reason: decision.reason };
    const blocked = this.blockedReason(signal, now);
    const notificationOnly = !AUTOMATIC_SPEECH_EVENTS.has(signal.eventType);
    if (resolved.action === 'notify' || blocked || notificationOnly) {
      const reason = notificationOnly
        ? 'event-notification-only'
        : resolved.action === 'notify'
          ? 'rule-notify'
          : (blocked ?? 'voice-disabled');
      this.notify(signal, reason);
      return { action: 'notify', reason };
    }
    return this.dispatchSpeak({
      priority: resolved.rule?.priority ?? priorityForEvent(signal.eventType),
      // 只在出声前归一化；通知与看板仍用原文。
      text: normalizeForSpeech(
        this.announcementText(resolved.text ?? '', signal, resolved.rule?.template),
      ),
      signal,
      ...(delay > 0 ? { notBefore: Date.now() + delay } : {}),
    });
  }

  /**
   * @description: 按"播报内容"设置组装文本。
   * 'title' 只播会话标题与工具名——用户输入正文可能又长又尴尬，且标题本身是输入的
   * 前 40 字，需要先清成可听的短语（spokenTaskTitle）。自定义模板尊重用户原文。
   * 'prompt' 保留完整正文，仅在标题缺失时用短编号兜底。
   */
  private announcementText(
    text: string,
    signal: TransitionSignal,
    template?: string | null,
  ): string {
    // 'prompt' 保留适配器给的 40 字标题原文（自定义模板同样按原文渲染）。
    if (this.deps.getSettings().voice.content === 'prompt') return withTaskIdentity(text, signal);
    const spoken = spokenTaskTitle(signal);
    const body = renderTemplate(template?.trim() || defaultTemplateForEvent(signal.eventType), {
      ...signal,
      title: spoken,
    });
    // 模板已含标题时不再重复拼接工具名。
    return body.includes(spoken) ? body : withTaskIdentity(body, { ...signal, title: spoken });
  }

  /** @description: 显式试听不受自动通知开关限制，不改变用户静音设置。 */
  async speakText(text: string): Promise<SpeakResult> {
    if (this.stopped) return { ok: false, errors: ['播报服务已停止'] };
    this.cancelPending('preview-interrupted', true);
    const generation = this.generation;
    const chain = this.deps.getChain();
    this.previewing = true;
    this.activeChain = chain;
    const settings = this.deps.getSettings();
    try {
      await this.playbackBarrier;
      if (generation !== this.generation) return { ok: false, errors: ['播报已打断'] };
      const playback = chain.speak({
        text: truncateText(normalizeForSpeech(text), 200),
        voiceProfile: settings.voice.voiceProfile,
        rate: settings.voice.rate,
        volume: settings.voice.volume,
      });
      this.playback = playback;
      return await playback;
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    } finally {
      if (generation === this.generation) {
        this.activeChain = null;
        this.playback = null;
        this.previewing = false;
        this.playNext();
      }
    }
  }

  /** @description: 宿主写入设置后调用，取消旧后端并按新规则处理未播的提醒。 */
  reconfigure(): void {
    if (!this.stopped) this.cancelPending('settings-changed', true);
  }

  /** @description: 退出时停止当前播放和队列，不再产生系统通知。 */
  stop(): void {
    this.stopped = true;
    this.cancelPending('service-stopped', false);
  }

  private rules(): VoiceRule[] {
    return listVoiceRules(this.deps.db).map(toVoiceRule);
  }

  private blockedReason(signal: TransitionSignal, now = new Date()): string | null {
    const settings = this.deps.getSettings();
    if (!settings.voice.enabled) return 'voice-disabled';
    if (settings.quiet.globalMute) return 'global-muted';
    return isQuiet({ ...settings.quiet, eventType: signal.eventType, now }) ? 'quiet-hours' : null;
  }

  /** @description: 只取消实际持有的后端，避免宿主换链后旧进程成为孤儿。 */
  private cancelPending(reason: string, notify: boolean): void {
    this.generation += 1;
    if (this.queueWakeTimer) clearTimeout(this.queueWakeTimer);
    this.queueWakeTimer = undefined;
    this.queueWakeAt = Infinity;
    this.waitForOldPlayback();
    this.activeChain?.cancel();
    this.activeChain = null;
    this.previewing = false;
    const pending: QueuedSpeak[] = [];
    if (this.speaking) pending.push(this.speaking);
    this.speaking = null;
    for (let item = this.queue.dequeue(); item; item = this.queue.dequeue()) pending.push(item);
    if (notify) {
      const rules = this.rules();
      for (const item of pending) {
        if (resolveAction(rules, item.signal).action !== 'mute') this.notify(item.signal, reason);
      }
    }
  }

  private waitForOldPlayback(): void {
    if (this.playback)
      this.playbackBarrier = this.playback.then(
        () => undefined,
        () => undefined,
      );
    this.playback = null;
  }

  private async dispatchSpeak(item: QueuedSpeak): Promise<VoiceOutcome> {
    if (item.notBefore && item.notBefore > Date.now()) {
      this.queue.enqueue(item);
      this.scheduleQueue(item.notBefore);
      return { action: 'speak', reason: 'queued-cooldown', text: item.text };
    }
    if (
      this.previewing ||
      (this.speaking && !canInterrupt(this.speaking.priority, item.priority))
    ) {
      this.queue.enqueue(item);
      return { action: 'speak', reason: 'queued', text: item.text };
    }
    if (this.speaking) {
      const interrupted = this.speaking;
      this.generation += 1;
      this.waitForOldPlayback();
      this.activeChain?.cancel();
      this.speaking = null;
      this.activeChain = null;
      this.notify(interrupted.signal, 'higher-priority');
    }
    return this.play(item);
  }

  private async play(item: QueuedSpeak): Promise<VoiceOutcome> {
    if (this.stopped) return { action: 'skipped', reason: 'service-stopped' };
    // 排队期间设置或规则可能改变，出声前重新核对范围、静音和文案。
    const resolved = resolveAction(this.rules(), item.signal);
    if (resolved.action === 'mute') {
      this.playNext();
      return { action: 'mute' };
    }
    const blocked = this.blockedReason(item.signal);
    const notificationOnly = !AUTOMATIC_SPEECH_EVENTS.has(item.signal.eventType);
    const inScope = inBroadcastScope(this.deps.getSettings().voice.scope, item.signal.eventType);
    if (resolved.action === 'notify' || blocked || notificationOnly || !inScope) {
      const reason = !inScope
        ? 'out-of-scope'
        : notificationOnly
          ? 'event-notification-only'
          : (blocked ?? 'rule-notify');
      this.notify(item.signal, reason);
      this.playNext();
      return { action: 'notify', reason };
    }
    const generation = this.generation;
    const chain = this.deps.getChain();
    this.speaking = item;
    this.activeChain = chain;
    const settings = this.deps.getSettings();
    let speak: SpeakResult;
    try {
      await this.playbackBarrier;
      if (generation !== this.generation) return { action: 'skipped', reason: 'interrupted' };
      item.text = normalizeForSpeech(
        this.announcementText(resolved.text ?? '', item.signal, resolved.rule?.template),
      );
      const playback = chain.speak({
        text: item.text,
        voiceProfile: settings.voice.voiceProfile,
        rate: settings.voice.rate,
        volume: settings.voice.volume,
      });
      this.playback = playback;
      speak = await playback;
    } catch (error) {
      speak = { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
    if (generation !== this.generation) return { action: 'skipped', reason: 'interrupted', speak };
    this.speaking = null;
    this.activeChain = null;
    this.playback = null;
    if (!speak.ok) this.notify(item.signal, 'tts-failed');
    this.playNext();
    return {
      action: speak.ok ? 'speak' : 'notify',
      reason: speak.ok ? undefined : 'tts-failed',
      text: item.text,
      speak,
    };
  }

  private playNext(): void {
    if (this.stopped || this.previewing) return;
    const next = this.queue.dequeue();
    if (next) {
      if (next.notBefore && next.notBefore > Date.now()) {
        this.queue.enqueue(next);
        this.scheduleQueue(next.notBefore);
        return;
      }
      if (this.speaking && !canInterrupt(this.speaking.priority, next.priority)) {
        this.queue.enqueue(next);
        return;
      }
      void this.dispatchSpeak(next).catch(() => {
        // 不输出任务内容；下一项仍须继续处理。
        this.speaking = null;
        this.activeChain = null;
        process.stderr.write('播报队列处理失败\n');
        this.playNext();
      });
    }
  }

  /** @description: 冷却中的新任务最长等待两秒；实际播放仍经同一优先级队列串行。 */
  private scheduleQueue(at: number): void {
    if (this.queueWakeTimer && this.queueWakeAt <= at) return;
    if (this.queueWakeTimer) clearTimeout(this.queueWakeTimer);
    this.queueWakeAt = at;
    this.queueWakeTimer = setTimeout(
      () => {
        this.queueWakeTimer = undefined;
        this.queueWakeAt = Infinity;
        this.playNext();
      },
      Math.max(0, at - Date.now()),
    );
    this.queueWakeTimer.unref();
  }

  private notify(signal: TransitionSignal, reason: string): void {
    this.deps.onNotify?.({
      title: voiceToolName(signal) + ' · ' + describeEvent(signal.eventType),
      body: voiceTaskTitle(signal),
      attention: isAttentionEvent(signal.eventType),
      reason,
      sessionId: signal.sessionId,
    });
  }
}

/** 需要用户介入的事件类型 */
const ATTENTION_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'task.waiting_human',
  'task.failed',
  'task.timeout',
  'heartbeat.lost',
]);

/**
 * 判断事件是否需要用户立即介入。
 * @param eventType 事件类型
 * @returns 是否需要介入
 */
export function isAttentionEvent(eventType: EventType): boolean {
  return ATTENTION_EVENTS.has(eventType);
}

/**
 * 事件类型的中文短名，用于通知标题。
 * @param eventType 事件类型
 * @returns 中文短名
 */
export function describeEvent(eventType: EventType): string {
  const labels: Record<EventType, string> = {
    'task.started': '任务开始',
    'task.waiting_human': '等你拍板',
    'human.responded': '已恢复执行',
    'task.failed': '任务失败',
    'task.completed': '任务完成',
    'task.retried': '重试中',
    'task.archived': '已归档',
    'task.timeout': '等待超时',
    'task.cancelled': '已取消',
    'heartbeat.lost': '心跳丢失',
    'tool.detected': '发现工具',
    anomaly: '异常信号',
  };
  return labels[eventType];
}
