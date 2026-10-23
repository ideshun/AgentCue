import { describe, expect, it } from 'vitest';
import { clineHookDescriptor, clineHookScripts, normalizeClineHook } from '@awm/adapters';

/** 根据公开 4.1.25 HooksAdapter 构造，不读取真实扩展状态或用户会话。 */
const occurredAt = '2026-10-21T00:00:00.000Z';
const common = {
  clineVersion: '4.1.25',
  hookName: 'TaskStart',
  timestamp: String(Date.parse(occurredAt)),
  taskId: 'synthetic-cline-conversation',
  workspaceRoots: ['/tmp/synthetic-cline-project'],
  userId: 'synthetic-user-id',
};
const started = {
  ...common,
  taskStart: { taskMetadata: { taskId: common.taskId, ulid: '', initialTask: '优化设置页面' } },
};

describe('Cline 4.1.25 hooks 契约', () => {
  it('仅输出散列身份、原生发生时间与最多40字符的用户标题', () => {
    const [event] = normalizeClineHook(started);
    expect(event).toMatchObject({
      toolId: 'cline',
      eventType: 'task.started',
      occurredAt,
      actor: 'tool',
      payload: { taskTitle: '优化设置页面' },
      schemaVersion: 1,
    });
    expect(event?.eventId).toMatch(/^evt_hook_[a-f0-9]{64}$/);
    expect(event?.sessionId).toMatch(/^cline:hooks:[a-f0-9]{64}$/);
    expect(event?.sessionId).not.toContain(common.taskId);
    expect(JSON.stringify(event)).not.toContain(common.workspaceRoots[0]);
    expect(JSON.stringify(event)).not.toContain(common.userId);
  });

  it('重投事件身份不依赖接收时间、正文、宿主和其他私有字段', () => {
    const first = normalizeClineHook(started)[0]!;
    const duplicate = normalizeClineHook(
      {
        ...started,
        host: 'Cursor',
        userId: 'other',
        workspaceRoots: ['/tmp/other'],
        taskStart: { taskMetadata: { initialTask: '重投正文有所变化' } },
      },
      { phase: 'TaskStart', receivedAt: '2026-10-22T00:00:00.000Z' },
    )[0]!;
    expect(duplicate.eventId).toBe(first.eventId);
    expect(duplicate.sessionId).toBe(first.sessionId);
    expect(duplicate.occurredAt).toBe(occurredAt);
    const next = normalizeClineHook({
      ...started,
      timestamp: String(Number(common.timestamp) + 1),
    })[0]!;
    expect(next.eventId).not.toBe(first.eventId);
    expect(next.sessionId).toBe(first.sessionId);
    expect(next.sessionId).not.toContain(':turn:');
    expect(normalizeClineHook({ ...started, taskId: 'other-task' })[0]?.sessionId).not.toBe(
      first.sessionId,
    );
  });

  it.each([
    ['TaskComplete', 'task.completed'],
    ['TaskCancel', 'task.cancelled'],
  ] as const)('%s 只映射已声明终态，不读取助手结果作标题或猜测失败', (hookName, eventType) => {
    const [event] = normalizeClineHook({
      ...common,
      hookName,
      taskComplete: {
        taskMetadata: { result: '{"risk_level":"low","user_authorization":"explicit"}' },
      },
      taskCancel: { taskMetadata: { completionStatus: 'cancelled' } },
      status: 'error',
      reason: 'not-a-native-error',
    });
    expect(event?.eventType).toBe(eventType);
    expect(event?.payload).toEqual({});
    expect(event?.sessionId).toBe(normalizeClineHook(started)[0]?.sessionId);
    expect(event?.eventId).not.toBe(normalizeClineHook(started)[0]?.eventId);
    expect(JSON.stringify(event)).not.toContain('risk_level');
  });

  it('标题清理控制上下文、保留真实用户 JSON，且允许没有标题的有效开始', () => {
    const initialTask = '<environment_context>公开合成上下文</environment_context>\n优化设置页面';
    const event = normalizeClineHook({
      ...started,
      taskStart: { taskMetadata: { initialTask } },
    })[0]!;
    expect(event.payload).toEqual({ taskTitle: '优化设置页面' });
    const json = '{"risk_level":"low"}';
    expect(
      normalizeClineHook({ ...started, taskStart: { taskMetadata: { initialTask: json } } })[0]
        ?.payload,
    ).toEqual({ taskTitle: json });
    const long = normalizeClineHook({
      ...started,
      taskStart: { taskMetadata: { initialTask: '任务😀'.repeat(30) } },
    })[0]!;
    expect(Array.from(long.payload.taskTitle ?? '')).toHaveLength(40);
    expect(
      normalizeClineHook({ ...started, taskStart: { taskMetadata: { initialTask: '' } } })[0]
        ?.payload,
    ).toEqual({});
  });

  it('强制验证 hookName，显式阶段不能补造或覆盖原生阶段', () => {
    expect(normalizeClineHook(started, { phase: 'TaskStart' })).toEqual(
      normalizeClineHook(started),
    );
    expect(() => normalizeClineHook(started, { phase: 'TaskComplete' })).toThrow('不一致');
    const withoutName: Partial<typeof started> = { ...started };
    delete withoutName.hookName;
    expect(() => normalizeClineHook(withoutName, { phase: 'TaskStart' })).toThrow('hookName');
    expect(() => normalizeClineHook(started, { receivedAt: 'invalid' })).toThrow();
  });

  it.each(['Notification', 'TaskResume', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'])(
    '不把未接入的 %s 猜成开始、审批或终态',
    (hookName) => {
      expect(
        normalizeClineHook({
          ...common,
          hookName,
          notification: { event: 'user_attention', waitingForUserInput: true },
        }),
      ).toEqual([]);
    },
  );

  it.each([null, [], 'invalid', 42])('拒绝非对象输入 %#', (input) => {
    expect(() => normalizeClineHook(input)).toThrow('JSON 对象');
  });

  it.each([
    { taskId: '' },
    { taskId: null },
    { timestamp: 0 },
    { timestamp: '' },
    { timestamp: '2026-10-21T00:00:00Z' },
    { timestamp: '-1' },
    { timestamp: '1.5' },
    { timestamp: 'NaN' },
    { timestamp: '99999999999999999999' },
    { timestamp: '8640000000000001' },
    { hookName: true },
    { taskStart: {} },
    { taskStart: { taskMetadata: { initialTask: 123 } } },
  ])('拒绝无效的原生身份、时间或用户标题字段 %#', (patch) => {
    expect(() => normalizeClineHook({ ...started, ...patch })).toThrow();
  });

  it('仅生成用户可检查并自行配置的三个全局可执行脚本', () => {
    const command = '"/tmp/Synthetic Monitor.app/Contents/MacOS/Monitor" --tool-hook cline';
    const scripts = clineHookScripts(command);
    expect(clineHookDescriptor).toMatchObject({
      toolId: 'cline',
      mode: 'session',
      phases: ['TaskStart', 'TaskComplete', 'TaskCancel'],
    });
    expect(scripts).toEqual(
      clineHookDescriptor.phases.map((phase) => ({
        path: `~/Documents/Cline/Hooks/${phase}`,
        content: `#!/bin/sh\nexec ${command} --hook-phase ${phase}\n`,
        executable: true,
      })),
    );
    expect(JSON.stringify(scripts)).not.toContain('UserPromptSubmit');
    expect(JSON.stringify(scripts)).not.toContain('Notification');
  });

  it.each(['', ' ', '/tmp/monitor\necho unsafe', '/tmp/monitor\0'])(
    '拒绝空命令或含控制字符的脚本命令 %#',
    (command) => {
      expect(() => clineHookScripts(command)).toThrow();
    },
  );
});
