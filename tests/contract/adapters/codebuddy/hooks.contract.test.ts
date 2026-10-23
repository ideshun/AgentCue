import { describe, expect, it } from 'vitest';
import { codebuddyHookDescriptor, codebuddyHookSnippet, normalizeCodeBuddyHook } from '@awm/adapters';

/** 依据官方 IDE 字段构造；不读取真实 transcript、设置或会话。 */
const common = {
  session_id: 'synthetic-codebuddy-session',
  transcript_path: '/tmp/never-read-codebuddy-transcript.txt',
  cwd: '/tmp/synthetic-project',
};
const started = { ...common, hook_event_name: 'UserPromptSubmit', prompt: '优化页面布局' };
const stopped = { ...common, hook_event_name: 'Stop', stop_hook_active: false };
const receivedAt = '2026-10-21T00:00:00.000Z';

describe('CodeBuddy IDE hooks 契约', () => {
  it('只传递散列后的会话身份和用户标题', () => {
    const [event] = normalizeCodeBuddyHook(started, { receivedAt });
    expect(event).toMatchObject({ toolId: 'codebuddy', eventType: 'task.started', actor: 'tool', occurredAt: receivedAt, payload: { taskTitle: '优化页面布局' }, schemaVersion: 1 });
    expect(event?.sessionId).toMatch(/^codebuddy:hooks:[a-f0-9]{64}$/);
    expect(event?.sessionId).not.toContain(common.session_id);
    expect(event?.eventId).toMatch(/^evt_hook_[a-f0-9]{64}$/);
    expect(event?.payload).toEqual({ taskTitle: '优化页面布局' });
    expect(JSON.stringify(event)).not.toContain(common.transcript_path);
    expect(JSON.stringify(event)).not.toContain(common.cwd);
  });

  it('Stop 仅表示响应结束，不根据未声明的错误、取消和审批字段猜状态', () => {
    const [event] = normalizeCodeBuddyHook({ ...stopped, status: 'error', cancelled: true, requires_approval: true, prompt: '内部文本', text: '{"risk_level":"low"}' }, { receivedAt });
    expect(event?.eventType).toBe('task.completed');
    expect(event?.payload).toEqual({});
    expect(event?.sessionId).toBe(normalizeCodeBuddyHook(started, { receivedAt })[0]?.sessionId);
  });

  it('相同投递的身份稳定，改变接收时间才能区分新一轮开始投递', () => {
    const first = normalizeCodeBuddyHook(started, { receivedAt })[0]!;
    const duplicate = normalizeCodeBuddyHook({ ...started, prompt: '重投正文变化', attachments: ['/tmp/file'] }, { receivedAt })[0]!;
    const next = normalizeCodeBuddyHook(started, { receivedAt: '2026-10-21T00:01:00.000Z' })[0]!;
    expect(duplicate.eventId).toBe(first.eventId);
    expect(next.eventId).not.toBe(first.eventId);
    expect(next.sessionId).toBe(first.sessionId);
    expect(normalizeCodeBuddyHook(stopped, { receivedAt })[0]?.eventId).not.toBe(first.eventId);
  });

  it('没有逐轮身份时不从正文或 stop_hook_active 编造轮次', () => {
    const one = normalizeCodeBuddyHook(stopped, { receivedAt })[0]!;
    const two = normalizeCodeBuddyHook({ ...stopped, stop_hook_active: true, text: '助手文字' }, { receivedAt })[0]!;
    expect(two).toEqual(one);
    expect(normalizeCodeBuddyHook({ ...started, session_id: 'other' }, { receivedAt })[0]?.sessionId).not.toBe(one.sessionId);
  });

  it('已验证 IDE generation_id 跨接收时间稳定，每轮身份独立', () => {
    const first = normalizeCodeBuddyHook({ ...started, generation_id: 'request-1' }, { receivedAt })[0]!;
    const duplicate = normalizeCodeBuddyHook({ ...started, generation_id: 'request-1', prompt: '重复投递' }, { receivedAt: '2026-10-21T01:00:00.000Z' })[0]!;
    const second = normalizeCodeBuddyHook({ ...started, generation_id: 'request-2' }, { receivedAt })[0]!;
    expect(first.sessionId).toMatch(/^codebuddy:hooks:[a-f0-9]{64}:turn:[a-f0-9]{64}$/);
    expect(duplicate.eventId).toBe(first.eventId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.eventId).not.toBe(first.eventId);
    expect(normalizeCodeBuddyHook({ ...stopped, generation_id: 'request-1' }, { receivedAt })[0]?.sessionId).toBe(first.sessionId);
  });

  it.each([undefined, null, '', ' ', 42])('缺少有效 generation_id %s 时兼容旧 IDE 会话身份', (generation_id) => {
    expect(normalizeCodeBuddyHook({ ...started, generation_id }, { receivedAt })[0]?.sessionId).toMatch(/^codebuddy:hooks:[a-f0-9]{64}$/);
  });

  it('标题最多40字符且保留合法用户 JSON，不从控制文本或响应取标题', () => {
    expect(Array.from(normalizeCodeBuddyHook({ ...started, prompt: '任务'.repeat(40) }, { receivedAt })[0]?.payload.taskTitle ?? '')).toHaveLength(40);
    expect(normalizeCodeBuddyHook({ ...started, prompt: '{"risk_level":"low"}' }, { receivedAt })[0]?.payload).toEqual({ taskTitle: '{"risk_level":"low"}' });
    expect(normalizeCodeBuddyHook({ ...started, prompt: '<environment_context>内部环境</environment_context>' }, { receivedAt })[0]?.payload).toEqual({});
  });

  it('显式 phase 可提供缺失的名称，但不能与现有名称冲突', () => {
    const payload: Partial<typeof started> = { ...started };
    delete payload.hook_event_name;
    expect(normalizeCodeBuddyHook(payload, { phase: 'UserPromptSubmit', receivedAt })).toEqual(normalizeCodeBuddyHook(started, { receivedAt }));
    expect(() => normalizeCodeBuddyHook(stopped, { phase: 'UserPromptSubmit', receivedAt })).toThrow('不一致');
  });

  it.each(['SessionStart', 'SessionEnd', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'Notification', 'PermissionRequest'])('不将 %s 猜成用户任务或等待状态', (hook_event_name) => {
    expect(normalizeCodeBuddyHook({ ...common, hook_event_name }, { receivedAt })).toEqual([]);
  });

  it.each([null, [], 'invalid', 42])('拒绝非对象输入 %#', (input) => {
    expect(() => normalizeCodeBuddyHook(input)).toThrow('JSON 对象');
  });

  it.each([{ session_id: '' }, { session_id: ' ' }, { session_id: null }, { prompt: 1 }, { hook_event_name: 1 }])('拒绝无效开始字段 %#', (patch) => {
    expect(() => normalizeCodeBuddyHook({ ...started, ...patch }, { receivedAt })).toThrow();
  });

  it('拒绝缺少阶段和无效接收时间', () => {
    expect(() => normalizeCodeBuddyHook({ ...common, prompt: '请求' })).toThrow('hook_event_name');
    expect(() => normalizeCodeBuddyHook(started, { receivedAt: 'invalid' })).toThrow();
  });

  it('IDE 配置采用嵌套 hooks，只有两个观察阶段', () => {
    const command = '"/tmp/Synthetic Monitor.app/Contents/MacOS/Monitor" --tool-hook codebuddy';
    const entry = { hooks: [{ type: 'command', command, timeout: 3 }] };
    expect(JSON.parse(codebuddyHookSnippet(command))).toEqual({ hooks: { UserPromptSubmit: [entry], Stop: [entry] } });
    expect(codebuddyHookDescriptor).toMatchObject({ toolId: 'codebuddy', mode: 'session', phases: ['UserPromptSubmit', 'Stop'], configPath: '~/.codebuddy/settings.json' });
    expect(JSON.parse(codebuddyHookSnippet(command, { timeoutSeconds: 1.5 })).hooks.Stop[0].hooks[0].timeout).toBe(1.5);
    expect(codebuddyHookSnippet(command)).not.toContain('failClosed');
    expect(codebuddyHookSnippet(command)).not.toContain('continue');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('拒绝无效 timeout %s', (timeoutSeconds) => {
    expect(() => codebuddyHookSnippet('/tmp/monitor --tool-hook codebuddy', { timeoutSeconds })).toThrow('timeout');
  });

  it('拒绝空启动命令', () => {
    expect(() => codebuddyHookSnippet(' ')).toThrow('不能为空');
  });
});
