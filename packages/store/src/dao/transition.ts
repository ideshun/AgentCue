/**
 * 状态迁移落库（跨表事务）。
 * 对应 FLOW-02 第 4 步：写 state_events 与 sessions.current_state 必须在同一事务。
 */
import type { StandardEvent, TaskState } from '@awm/schema';
import type { AppDb } from '../db';
import { sessions, stateEvents } from '../schema';

/** 迁移落库入参 */
export interface PersistTransitionInput {
  /** 触发迁移的标准事件 */
  event: StandardEvent;
  /** 迁移前状态，新建会话为 null */
  prevState: TaskState | null;
  /** 迁移后状态 */
  nextState: TaskState;
  /** 项目标识，用于拼装展示信息 */
  project?: string | null;
  /** 任务标题，缺省取事件 payload.taskTitle */
  title?: string | null;
  /** 结束时间，终态迁移时传入 */
  endedAt?: string | null;
}

/**
 * 在同一事务内更新会话当前态并追加状态事件。
 * @param db 数据库句柄
 * @param input 迁移内容
 */
export function persistTransition(db: AppDb, input: PersistTransitionInput): void {
  const { event, prevState, nextState } = input;
  const ts = event.occurredAt;
  const candidateTitle = input.title ?? event.payload.taskTitle;
  const title =
    typeof candidateTitle === 'string' && candidateTitle.trim() !== '' ? candidateTitle : null;

  db.transaction((tx) => {
    tx.insert(sessions)
      .values({
        sessionId: event.sessionId,
        toolId: event.toolId,
        project: input.project ?? null,
        title,
        currentState: nextState,
        startedAt: prevState === null || prevState === 'idle' ? ts : null,
        endedAt: input.endedAt ?? null,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: sessions.sessionId,
        set: {
          currentState: nextState,
          ...(title === null ? {} : { title }),
          endedAt: input.endedAt ?? null,
          updatedAt: ts,
        },
      })
      .run();

    tx.insert(stateEvents)
      .values({
        eventId: event.eventId,
        sessionId: event.sessionId,
        toolId: event.toolId,
        eventType: event.eventType,
        prevState,
        nextState,
        actor: event.actor,
        reason: event.payload.reason ?? null,
        ts,
        payload: JSON.stringify(event.payload),
      })
      .run();
  });
}
