/**
 * 状态机行为单测。
 * 覆盖：初始态、合法链路推进、非法迁移拒绝、与迁移表一致性、多会话隔离。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskActor, type TaskActorHandle } from './task-machine';

/** 测试期间创建的 actor，统一在 afterEach 停止 */
const actors: TaskActorHandle[] = [];

/** 创建并登记一个 actor */
function spawn(sessionId: string): TaskActorHandle {
  const actor = createTaskActor(sessionId);
  actors.push(actor);
  return actor;
}

afterEach(() => {
  while (actors.length > 0) {
    actors.pop()?.stop();
  }
});

describe('createTaskActor', () => {
  it('初始状态为 idle', () => {
    expect(spawn('demo:proj:s1').getState()).toBe('idle');
  });

  it('可按数据库中的当前态恢复 actor（进程重启场景）', () => {
    const restored = createTaskActor('demo:proj:restored', 'waiting_human');
    actors.push(restored);
    expect(restored.getState()).toBe('waiting_human');
    expect(restored.send('human.responded')).toBe('running');
  });

  it('沿合法链路推进状态', () => {
    const actor = spawn('demo:proj:s2');
    expect(actor.send('task.started')).toBe('running');
    expect(actor.send('task.waiting_human')).toBe('waiting_human');
    expect(actor.send('human.responded')).toBe('running');
    expect(actor.send('task.completed')).toBe('completed');
    expect(actor.getState()).toBe('completed');
  });

  it('非法迁移被拒绝且状态不变', () => {
    const actor = spawn('demo:proj:s3');
    actor.send('task.started');
    actor.send('task.completed');
    expect(actor.send('task.started')).toBeNull();
    expect(actor.getState()).toBe('completed');
  });

  it('failed 可经 retried 回到 running', () => {
    const actor = spawn('demo:proj:s4');
    actor.send('task.started');
    actor.send('task.failed');
    expect(actor.send('task.retried')).toBe('running');
  });

  it('waiting_human 可因心跳丢失转 timeout', () => {
    const actor = spawn('demo:proj:s5');
    actor.send('task.started');
    actor.send('task.waiting_human');
    expect(actor.send('heartbeat.lost')).toBe('timeout');
  });

  it('多个会话的 actor 互不干扰', () => {
    const first = spawn('demo:proj:a');
    const second = spawn('demo:proj:b');
    first.send('task.started');
    expect(first.getState()).toBe('running');
    expect(second.getState()).toBe('idle');
  });

  it('archived 后回到 idle 可再次开始', () => {
    const actor = spawn('demo:proj:s6');
    actor.send('task.started');
    actor.send('task.completed');
    expect(actor.send('task.archived')).toBe('idle');
    expect(actor.send('task.started')).toBe('running');
  });
});
