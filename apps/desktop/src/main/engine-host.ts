/**
 * 引擎宿主（主进程内装载 packages/core + packages/store）。
 * M0 职责：建库、事件总线消费、FSM 推进、迁移落库。
 */
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  createTaskActor,
  resolveTransition,
  SessionEventBus,
  type TaskActorHandle,
  type TransitionResult,
} from '@awm/core';
import {
  NON_TRANSITION_EVENT_TYPES,
  isTerminalLike,
  type StandardEvent,
  type TaskState,
  type SourceCheckpoint,
} from '@awm/schema';
import {
  appendAudit,
  appendStateEvent,
  createDatabase,
  ensureSessionRow,
  getEventSessionId,
  getSession,
  hasSourceEvent,
  persistTransition,
  listSourceSessions,
  listTimeline,
  listTools,
  recordSourceEvent,
  saveSourceCheckpoint,
  setSourceSessionsVisibility,
  updateSessionTitle,
  upsertTool,
  type AppDb,
} from '@awm/store';

export interface TransitionDelivery {
  /** 历史补采仍广播迁移，但宿主应跳过通知和播报。 */
  announce: boolean;
}

/** @description: Hook 复用同一会话身份时，这些终态要先经 task.archived 回到 idle 才能开始新一轮。 */
const HOOK_REOPEN_STATES: readonly string[] = ['completed', 'cancelled', 'failed', 'timeout'];

/**
 * 监控引擎：会话级 actor 池 + 事件总线 + 持久化。
 */
export class Engine {
  /** 数据库句柄 */
  private readonly db: AppDb;

  /** 事件总线，按会话串行消费 */
  private readonly bus: SessionEventBus;

  /** 会话 actor 池 */
  private readonly actors = new Map<string, TaskActorHandle>();
  private transitionBuffer: Array<{ result: TransitionResult; event: StandardEvent }> | null = null;

  /**
   * 迁移完成回调，用于 SSE 推送与播报编排。
   * 由主进程在启动时注入，缺省为空实现。
   */
  public onTransition?: (
    result: TransitionResult,
    event: StandardEvent,
    delivery?: TransitionDelivery,
  ) => void;

  /**
   * 是否写入审计日志。默认开启，宿主按 settings.privacy.auditLog 注入。
   */
  public shouldAudit: () => boolean = () => true;

  /**
   * @param dataDir 应用数据目录，数据文件 awm.db 落于其中
   */
  constructor(dataDir: string) {
    // 首次启动时 userData 目录可能尚未创建，先确保存在再开库
    mkdirSync(dataDir, { recursive: true });
    const handle = createDatabase(path.join(dataDir, 'awm.db'));
    this.db = handle.db;
    this.bus = new SessionEventBus((event) => {
      this.handleEvent(event);
    });
  }

  /**
   * 启动引擎。
   * 后台任务（自动扫描、心跳轮询）由 MonitorService 承载，此处保留异步签名供后续扩展。
   */
  async start(): Promise<void> {
    await Promise.resolve();
  }

  /**
   * 注入一个标准事件。
   * @param event 标准事件
   */
  ingest(event: StandardEvent): void {
    this.bus.enqueue(event);
  }

  /** @description: 原生 hooks 单次入库；不伪造文件检查点，收据与任务状态同事务提交。 */
  async consumeHookEvent(
    input: StandardEvent,
    mode: 'turn' | 'session',
    canCommit: () => boolean,
    toolName: string,
  ): Promise<{ accepted: boolean; sessionId: string }> {
    await this.bus.idle();
    const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
    const baseSessionId = input.sessionId;
    const fallbackId =
      mode === 'turn'
        ? baseSessionId
        : `${baseSessionId}:turn:${digest(input.eventId).slice(0, 24)}`;
    if (!canCommit()) return { accepted: false, sessionId: fallbackId };
    const originalSessionId = getEventSessionId(this.db, input.eventId);
    if (hasSourceEvent(this.db, input.eventId))
      return { accepted: false, sessionId: originalSessionId ?? fallbackId };
    const event = { ...input, occurredAt: new Date(input.occurredAt).toISOString() };
    let sessionId = fallbackId;
    let recoveredLateStart = false;
    let accepted = false;
    const effects: Array<{ result: TransitionResult; event: StandardEvent }> = [];
    const silentIds = new Set<string>();
    const synthetic = (
      eventType: StandardEvent['eventType'],
      taskId: string,
      reason: string,
      title?: string | null,
    ): void => {
      const eventId = `evt_hook_synthetic_${digest(JSON.stringify([event.eventId, eventType, taskId]))}`;
      silentIds.add(eventId);
      if (hasSourceEvent(this.db, eventId)) return;
      this.handleEvent({
        ...event,
        eventId,
        sessionId: taskId,
        eventType,
        actor: 'system',
        payload: { reason, ...(title?.trim() ? { taskTitle: title } : {}) },
      });
      recordSourceEvent(this.db, eventId);
    };
    this.transitionBuffer = effects;
    try {
      this.db.transaction(() => {
        const tool = listTools(this.db).find((item) => item.toolId === event.toolId);
        upsertTool(this.db, {
          toolId: event.toolId,
          name: toolName,
          adapterId: event.toolId,
          detectStatus: 'running',
          version: tool?.version,
          configPath: tool?.configPath,
          executablePath: tool?.executablePath,
        });
        if (mode === 'session' && event.eventType !== 'task.started') {
          sessionId =
            listSourceSessions(this.db, baseSessionId, {
              startedAtOrBefore: event.occurredAt,
            })[0]?.sessionId ?? fallbackId;
        }
        if (mode === 'session' && event.eventType === 'task.started') {
          const recovered = listSourceSessions(this.db, baseSessionId, {
            states: ['completed', 'cancelled', 'failed', 'timeout'],
          })
            .reverse()
            .find((candidate) => {
              if (!candidate.startedAt || candidate.startedAt < event.occurredAt) return false;
              // 不能截断时间线，否则已匹配的早期开始记录可能被忽略并重复关联。
              const timeline = listTimeline(this.db, candidate.sessionId, Number.MAX_SAFE_INTEGER);
              const missingStart = timeline.some(
                (entry) =>
                  entry.eventType === 'task.started' &&
                  entry.actor === 'system' &&
                  entry.reason === 'hook-missing-start',
              );
              if (!missingStart) return false;
              return !timeline.some((entry) => {
                if (entry.actor !== 'tool') return false;
                if (entry.eventType === 'task.started') return true;
                if (entry.eventType !== 'anomaly' || entry.reason !== 'out-of-order') return false;
                try {
                  const payload: unknown = JSON.parse(entry.payload ?? '{}');
                  return (
                    payload !== null &&
                    typeof payload === 'object' &&
                    'originalEventType' in payload &&
                    payload.originalEventType === 'task.started'
                  );
                } catch {
                  // 损坏的历史记录无法证明尚未关联，保守跳过该轮。
                  return true;
                }
              });
            });
          if (recovered) {
            sessionId = recovered.sessionId;
            recoveredLateStart = true;
          }
        }
        if (mode === 'session' && event.eventType === 'task.started' && !recoveredLateStart) {
          for (const previous of listSourceSessions(this.db, baseSessionId, {
            startedAtOrBefore: event.occurredAt,
            states: ['running', 'waiting_human'],
          })) {
            if (previous.sessionId !== sessionId && previous.updatedAt <= event.occurredAt)
              synthetic('task.cancelled', previous.sessionId, 'hook-next-turn', previous.title);
          }
        }
        const current = getSession(this.db, sessionId);
        // Claude Code 的 Hook 身份由 transcript 派生，同一会话文件跨轮次复用同一条记录；
        // 上一轮已进入终态时，新提示词要先静默归档回 idle，否则会被回跳防护拒绝。
        if (
          event.toolId === 'claude-code' &&
          event.eventType === 'task.started' &&
          current &&
          HOOK_REOPEN_STATES.includes(current.currentState)
        )
          synthetic('task.archived', sessionId, 'hook-turn-reopen', current.title);
        if (event.eventType !== 'task.started' && (!current || current.currentState === 'idle'))
          synthetic('task.started', sessionId, 'hook-missing-start', event.payload.taskTitle);
        if (
          current?.currentState === 'waiting_human' &&
          (event.eventType === 'task.completed' || event.eventType === 'task.failed')
        )
          synthetic('human.responded', sessionId, 'hook-terminal-resumed', current.title);
        accepted =
          this.handleEvent({
            ...event,
            sessionId,
            ...(recoveredLateStart
              ? {
                  eventType: 'anomaly',
                  payload: {
                    reason: 'out-of-order',
                    originalEventType: 'task.started',
                    ...(event.payload.taskTitle?.trim()
                      ? { taskTitle: event.payload.taskTitle }
                      : {}),
                  },
                }
              : {}),
          }) !== null;
        if (event.payload.taskTitle?.trim())
          updateSessionTitle(this.db, sessionId, event.payload.taskTitle);
        recordSourceEvent(this.db, event.eventId);
      });
    } catch (error) {
      for (const actor of this.actors.values()) actor.stop();
      this.actors.clear();
      throw error;
    } finally {
      this.transitionBuffer = null;
    }
    for (const effect of effects)
      this.emitTransition(effect.result, effect.event, {
        announce: !silentIds.has(effect.event.eventId),
      });
    return { accepted, sessionId };
  }

  /** @description: 同事务提交来源事件、去重收据与读取位置，失败时恢复内存状态。 */
  async consumeSourceBatch(
    events: StandardEvent[],
    checkpoint: SourceCheckpoint,
    canCommit: () => boolean = () => true,
    titles: Array<{ sessionId: string; title: string | null }> = [],
    visibility?: { baseSessionId: string; visible: boolean },
    shouldAnnounce?: (event: StandardEvent) => boolean,
  ): Promise<string[]> {
    await this.bus.idle();
    if (!canCommit()) return [];
    const effects: Array<{ result: TransitionResult; event: StandardEvent }> = [];
    const processed: string[] = [];
    this.transitionBuffer = effects;
    try {
      this.db.transaction(() => {
        if (visibility)
          setSourceSessionsVisibility(this.db, visibility.baseSessionId, visibility.visible);
        for (const item of titles) updateSessionTitle(this.db, item.sessionId, item.title);
        const ordered = [...events].sort(
          (left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
        );
        for (const event of ordered) {
          if (hasSourceEvent(this.db, event.eventId)) continue;
          this.handleEvent(event);
          recordSourceEvent(this.db, event.eventId);
          processed.push(event.eventId);
        }
        for (const item of titles) updateSessionTitle(this.db, item.sessionId, item.title);
        saveSourceCheckpoint(this.db, checkpoint);
      });
    } catch (error) {
      for (const actor of this.actors.values()) actor.stop();
      this.actors.clear();
      throw error;
    } finally {
      this.transitionBuffer = null;
    }
    for (const effect of effects)
      this.emitTransition(
        effect.result,
        effect.event,
        shouldAnnounce ? { announce: shouldAnnounce(effect.event) } : undefined,
      );
    return processed;
  }

  /** @description: 来源元数据回填不改变任务状态或时间，也不触发播报。 */
  repairSourceTitles(
    titles: Array<{ sessionId: string; title: string | null }>,
    checkpoint: SourceCheckpoint | undefined,
    canCommit: () => boolean,
    visibility?: { baseSessionId: string; visible: boolean },
  ): boolean {
    if (!canCommit()) return false;
    let changed = false;
    this.db.transaction(() => {
      for (const item of titles)
        changed = updateSessionTitle(this.db, item.sessionId, item.title) || changed;
      if (visibility)
        changed =
          setSourceSessionsVisibility(this.db, visibility.baseSessionId, visibility.visible) ||
          changed;
      if (checkpoint) saveSourceCheckpoint(this.db, checkpoint);
    });
    return changed;
  }

  /**
   * 停止引擎：等待队列排空并释放 actor。
   */
  async stop(): Promise<void> {
    await this.bus.idle();
    for (const actor of this.actors.values()) {
      actor.stop();
    }
    this.actors.clear();
  }

  /**
   * 读取会话当前状态，未创建的会话返回 idle。
   * @param sessionId 会话 id
   * @returns 当前状态
   */
  getState(sessionId: string): string {
    return (
      this.actors.get(sessionId)?.getState() ??
      getSession(this.db, sessionId)?.currentState ??
      'idle'
    );
  }

  /**
   * 数据库句柄，供查询类门面使用。
   * @returns Drizzle 数据库句柄
   */
  get database(): AppDb {
    return this.db;
  }

  /**
   * 同步处理单个事件：推进状态机并落库，返回迁移结果。
   * @param event 标准事件
   * @returns 迁移结果；非法迁移或无需迁移时返回 null
   */
  applyEvent(event: StandardEvent): TransitionResult | null {
    return this.handleEvent(event);
  }

  /**
   * 处理单个事件：推进状态机并落库。
   * 三条路径：
   * 1. 非迁移类事件（anomaly / tool.detected）：只追加 state_events，不动会话状态
   * 2. 合法迁移：同事务更新会话态 + 追加事件，并触发 onTransition 三路分发
   * 3. 非法迁移：记审计日志（FLOW-02 约束 3、C-07），不抛错、不改状态
   * @param event 标准事件
   * @returns 迁移结果；非迁移事件与非法迁移返回 null
   */
  private handleEvent(event: StandardEvent): TransitionResult | null {
    const persisted = getSession(this.db, event.sessionId);
    if (persisted?.visible === 0) return null;
    if (
      persisted &&
      Date.parse(event.occurredAt) < Date.parse(persisted.updatedAt) &&
      !(NON_TRANSITION_EVENT_TYPES as readonly string[]).includes(event.eventType)
    ) {
      event = {
        ...event,
        eventType: 'anomaly',
        payload: {
          ...event.payload,
          reason: 'out-of-order',
          originalEventType: event.eventType,
        },
      };
    }
    const actor = this.actorFor(event.sessionId);
    const prevState = actor.getState();

    // 路径 1：非迁移类事件，仅记录
    if ((NON_TRANSITION_EVENT_TYPES as readonly string[]).includes(event.eventType)) {
      // state_events.session_id 有外键约束，先确保会话行存在（已存在则不动）
      ensureSessionRow(this.db, {
        sessionId: event.sessionId,
        toolId: event.toolId,
        state: prevState,
        ts: event.occurredAt,
      });
      appendStateEvent(this.db, {
        eventId: event.eventId,
        sessionId: event.sessionId,
        toolId: event.toolId,
        eventType: event.eventType,
        prevState,
        nextState: null,
        actor: event.actor,
        reason: event.payload.reason ?? null,
        ts: event.occurredAt,
        payload: event.payload,
      });
      return null;
    }

    const nextState = resolveTransition(prevState, event.eventType);

    // 路径 3：非法迁移（如 completed 回跳 running），记审计后丢弃
    if (nextState === null) {
      if (this.shouldAudit()) {
        appendAudit(this.db, {
          ts: event.occurredAt,
          actor: event.actor,
          action: 'illegal.transition.rejected',
          target: event.sessionId,
          result: `${prevState} 不接受 ${event.eventType}`,
        });
      }
      return null;
    }

    // 路径 2：合法迁移，跨表事务落库
    persistTransition(this.db, {
      event,
      prevState,
      nextState,
      endedAt: isTerminalLike(nextState) ? event.occurredAt : null,
    });
    actor.send(event.eventType);

    // 迁移结果经 onTransition 三路分发（SSE 推送 / 播报编排 / 界面刷新），由主进程装配层注入
    const result: TransitionResult = {
      sessionId: event.sessionId,
      prevState,
      nextState,
      eventType: event.eventType,
      ts: event.occurredAt,
    };
    if (this.transitionBuffer) this.transitionBuffer.push({ result, event });
    else this.emitTransition(result, event);
    return result;
  }

  private emitTransition(
    result: TransitionResult,
    event: StandardEvent,
    delivery?: TransitionDelivery,
  ): void {
    try {
      if (delivery) this.onTransition?.(result, event, delivery);
      else this.onTransition?.(result, event);
    } catch {
      // 已提交数据不因界面/通知失败回滚；后续刷新仍可读取到正确状态。
      process.stderr.write('状态已保存，但通知分发失败\n');
    }
  }

  /**
   * 获取或创建会话 actor。
   * @param sessionId 会话 id
   * @returns 该会话的 actor 句柄
   */
  private actorFor(sessionId: string): TaskActorHandle {
    const existing = this.actors.get(sessionId);
    if (existing) {
      return existing;
    }
    // 进程重启后内存 actor 为空，需按数据库中的当前态恢复，否则迁移会从 idle 误判为非法
    const persisted = getSession(this.db, sessionId)?.currentState as TaskState | undefined;
    const actor = createTaskActor(sessionId, persisted ?? 'idle');
    this.actors.set(sessionId, actor);
    return actor;
  }
}
