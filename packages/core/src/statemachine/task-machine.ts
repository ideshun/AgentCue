/**
 * 任务状态机（XState v5，每 session 一个 actor）。
 *
 * 设计约定：迁移合法性由 `transition-table` 单点裁决，XState 负责状态推进与副作用编排
 * （M1 起接入 30 分钟介入倒计时、播报触发等）。两者由单测断言保持一致，
 * 避免出现「表允许但机不动」或「机可动但表拒绝」的分叉。
 */
import { createActor, setup } from 'xstate';
import type { EventType, TaskState } from '@awm/schema';
import { resolveTransition } from './transition-table';

/** 状态机事件：type 即标准事件类型 */
export interface MachineEvent {
  /** 事件类型 */
  type: EventType;
}

/** 状态机上下文 */
export interface TaskContext {
  /** 会话 id */
  sessionId: string;
}

/** 任务状态机定义 */
export const taskMachine = setup({
  types: {} as {
    context: TaskContext;
    events: MachineEvent;
    input: { sessionId: string };
  },
  actions: {
    /**
     * 进入 waiting_human 的标记动作。
     * 30 分钟介入倒计时的实际实现在主进程 MonitorService.tick()：
     * 按 sessions.updated_at 判定并注入 task.timeout，不放在状态机内是为了
     * 让倒计时在进程重启后依然连续（状态机会从 idle 重建，定时器不会）。
     */
    startInterventionTimer: () => {
      // 仅作状态语义标记，不产生副作用
    },
  },
}).createMachine({
  id: 'task',
  initial: 'idle',
  context: ({ input }) => ({ sessionId: input.sessionId }),
  states: {
    idle: {
      on: { 'task.started': { target: 'running' } },
    },
    running: {
      on: {
        'task.waiting_human': 'waiting_human',
        'task.failed': 'failed',
        'task.completed': 'completed',
        'task.cancelled': 'cancelled',
        'heartbeat.lost': 'timeout',
      },
    },
    waiting_human: {
      entry: 'startInterventionTimer',
      on: {
        'human.responded': 'running',
        'task.timeout': 'timeout',
        'task.cancelled': 'cancelled',
        'heartbeat.lost': 'timeout',
      },
    },
    failed: {
      on: { 'task.retried': 'running', 'task.archived': 'idle' },
    },
    timeout: {
      on: { 'task.retried': 'running', 'task.archived': 'idle' },
    },
    // 约束 4：completed → running 无边，只能 archived 回 idle
    completed: {
      on: { 'task.archived': 'idle' },
    },
    cancelled: {
      on: { 'task.archived': 'idle' },
    },
  },
});

/** 任务 actor 操作句柄 */
export interface TaskActorHandle {
  /** 会话 id */
  readonly sessionId: string;
  /**
   * 获取当前状态。
   * @returns 当前任务状态
   */
  getState(): TaskState;
  /**
   * 投递事件并推进状态。
   * @param eventType 事件类型
   * @returns 目标状态；非法迁移返回 null
   */
  send(eventType: EventType): TaskState | null;
  /** 停止 actor，释放资源 */
  stop(): void;
}

/**
 * 从 idle 到达各状态的合法事件路径，用于进程重启后恢复 actor 状态。
 * 只使用迁移表中合法的边，保证恢复过程本身不会触发断言。
 */
const HYDRATION_PATH: Record<TaskState, EventType[]> = {
  idle: [],
  running: ['task.started'],
  waiting_human: ['task.started', 'task.waiting_human'],
  failed: ['task.started', 'task.failed'],
  completed: ['task.started', 'task.completed'],
  cancelled: ['task.started', 'task.cancelled'],
  timeout: ['task.started', 'heartbeat.lost'],
};

/**
 * 创建一个会话级任务 actor。
 * @param sessionId 会话 id
 * @param initialState 从数据库恢复的当前状态，缺省 idle
 * @returns 操作句柄
 */
export function createTaskActor(sessionId: string, initialState: TaskState = 'idle'): TaskActorHandle {
  const actor = createActor(taskMachine, { input: { sessionId } });
  actor.start();

  /** 读取状态机当前状态值 */
  const readState = (): TaskState => {
    const value = actor.getSnapshot().value;
    return typeof value === 'string' ? (value as TaskState) : 'idle';
  };

  // 恢复状态：按合法路径回放，使内存状态与数据库一致（应用重启后必需）
  for (const eventType of HYDRATION_PATH[initialState]) {
    actor.send({ type: eventType });
  }

  return {
    sessionId,
    getState: readState,
    send(eventType) {
      const prev = readState();
      const next = resolveTransition(prev, eventType);
      if (next === null) {
        return null;
      }
      actor.send({ type: eventType });
      const actual = readState();
      if (actual !== next) {
        throw new Error(
          `状态机与迁移表不一致：${prev} 收到 ${eventType}，迁移表期望 ${next}，状态机实际 ${actual}`,
        );
      }
      return next;
    },
    stop() {
      actor.stop();
    },
  };
}
