import { describe, expect, it } from 'vitest';
import { cursorHookDescriptor, cursorHookSnippet, normalizeCursorHook } from '@awm/adapters';

/** 全部为公开字段形状和自造值，不读取已安装客户端的用户数据。 */
const common = {
  conversation_id: 'conversation-demo',
  generation_id: 'generation-1',
  model: 'default',
  cursor_version: '3.25.9',
  workspace_roots: ['/tmp/synthetic-cursor-project'],
  user_email: null,
  transcript_path: null,
};
const started = {
  ...common, hook_event_name: 'beforeSubmitPrompt', prompt: '修复登录流程', attachments: [],
};
const stopped = { ...common, hook_event_name: 'stop', status: 'completed', loop_count: 0 };
const receivedAt = '2026-10-21T00:00:00.000Z';

describe('Cursor 原生 hooks 契约', () => {
  it('真实字段形状标准化为只含身份和用户标题的开始事件', () => {
    const [event] = normalizeCursorHook({ ...started, user_email: 'synthetic@example.invalid', transcript_path: '/tmp/never-read-transcript' }, { receivedAt });
    expect(event).toMatchObject({
      sessionId: 'cursor:hooks:conversation-demo:turn:generation-1',
      toolId: 'cursor', eventType: 'task.started', actor: 'tool', occurredAt: receivedAt, schemaVersion: 1,
      payload: { taskTitle: '修复登录流程' },
    });
    expect(event?.payload).toEqual({ taskTitle: '修复登录流程' });
    expect(Object.keys(event ?? {}).sort()).toEqual(['actor', 'eventId', 'eventType', 'occurredAt', 'payload', 'schemaVersion', 'sessionId', 'toolId']);
  });

  it.each([
    ['completed', 'task.completed'], ['aborted', 'task.cancelled'], ['error', 'task.failed'],
  ])('stop status=%s 映射为 %s，不从助手文本取得标题', (status, eventType) => {
    const [event] = normalizeCursorHook({ ...stopped, status, text: '{"risk_level":"low"}' }, { receivedAt });
    expect(event?.eventType).toBe(eventType);
    expect(event?.payload).toEqual({});
  });

  it('开始事件 ID 不受接收时间、标题、模型和其他原始字段影响', () => {
    const [first] = normalizeCursorHook(started, { receivedAt });
    const [duplicate] = normalizeCursorHook({ ...started, prompt: '再次投递的同轮请求', model: 'other', attachments: [{ type: 'file', file_path: '/tmp/attachment' }] }, { receivedAt: '2026-10-21T01:00:00.000Z' });
    expect(first?.eventId).toBe(duplicate?.eventId);
    expect(first?.sessionId).toBe(duplicate?.sessionId);
    expect(first?.eventId).toMatch(/^evt_hook_[a-f0-9]{64}$/);
  });

  it('同轮所有终态使用同一 phase ID，重试和状态差异不会触发第二次终态播报', () => {
    const ids = ['completed', 'aborted', 'error'].map((status, loop_count) =>
      normalizeCursorHook({ ...stopped, status, loop_count }, { receivedAt })[0]?.eventId,
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe(normalizeCursorHook(started, { receivedAt })[0]?.eventId);
  });

  it('同一对话多轮使用独立 sessionId，跨对话身份也不混用', () => {
    const one = normalizeCursorHook(started, { receivedAt })[0]!;
    const two = normalizeCursorHook({ ...started, generation_id: 'generation-2' }, { receivedAt })[0]!;
    const other = normalizeCursorHook({ ...started, conversation_id: 'other-conversation' }, { receivedAt })[0]!;
    expect(new Set([one.sessionId, two.sessionId, other.sessionId]).size).toBe(3);
    expect(new Set([one.eventId, two.eventId, other.eventId]).size).toBe(3);
    expect(normalizeCursorHook(stopped, { receivedAt })[0]?.sessionId).toBe(one.sessionId);
  });

  it('不透明 ID 内的分隔符编码后不会与另一组 ID 碰撞', () => {
    const one = normalizeCursorHook({ ...started, conversation_id: 'a:turn:b', generation_id: 'c' })[0]!;
    const two = normalizeCursorHook({ ...started, conversation_id: 'a', generation_id: 'b:turn:c' })[0]!;
    expect(one.sessionId).not.toBe(two.sessionId);
    expect(one.sessionId).toContain('a%3Aturn%3Ab');
  });

  it.each(['afterAgentResponse', 'afterAgentThought', 'sessionStart', 'sessionEnd', 'beforeMCPExecution'])('不把 %s 误报成开始、等待或第二个完成事件', (hook_event_name) => {
    expect(normalizeCursorHook({ ...common, hook_event_name, text: '助手文本' })).toEqual([]);
  });

  it('显式 phase 可替代缺失的 hook_event_name，但不允许冲突', () => {
    const payload: Partial<typeof started> = { ...started };
    delete payload.hook_event_name;
    expect(normalizeCursorHook(payload, { phase: 'beforeSubmitPrompt', receivedAt })).toEqual(normalizeCursorHook(started, { receivedAt }));
    expect(() => normalizeCursorHook(started, { phase: 'stop' })).toThrow('不一致');
  });

  it.each([null, [], 'bad json', 42])('拒绝非对象输入 %#', (input) => {
    expect(() => normalizeCursorHook(input)).toThrow('JSON 对象');
  });

  it.each([
    { conversation_id: '' }, { conversation_id: ' ' }, { generation_id: null }, { generation_id: '' },
    { hook_event_name: 1 }, { prompt: null },
  ])('拒绝缺少必要字段的开始输入 %#', (patch) => {
    expect(() => normalizeCursorHook({ ...started, ...patch })).toThrow();
  });

  it.each(['unknown', '', undefined, null, 'toString'])('拒绝未知 stop 状态 %s', (status) => {
    expect(() => normalizeCursorHook({ ...stopped, status })).toThrow('stop.status');
  });

  it('缺少阶段或无效接收时间不产生事件', () => {
    expect(() => normalizeCursorHook({ ...common, prompt: '用户请求' })).toThrow('hook_event_name');
    expect(() => normalizeCursorHook(started, { receivedAt: 'invalid-date' })).toThrow();
  });

  it('仅保留最多40个字符的真实用户标题，保留合法用户 JSON', () => {
    const prompt = '任务'.repeat(30) + '不应保留的尾部';
    expect(Array.from(normalizeCursorHook({ ...started, prompt })[0]?.payload.taskTitle ?? '')).toHaveLength(40);
    const json = '{"risk_level":"low"}';
    expect(normalizeCursorHook({ ...started, prompt: json })[0]?.payload).toEqual({ taskTitle: json });
    expect(normalizeCursorHook({ ...started, prompt: '<environment_context>内部环境</environment_context>' })[0]?.payload).toEqual({});
  });

  it('Agent 弹出提问框时按 AskQuestion 识别为待确认', () => {
    const question = { ...common, hook_event_name: 'preToolUse', tool_name: 'AskQuestion', tool_input: { questions: [] } };
    const [event] = normalizeCursorHook(question, { receivedAt });
    expect(event).toMatchObject({
      sessionId: 'cursor:hooks:conversation-demo:turn:generation-1',
      eventType: 'task.waiting_human',
      payload: {},
    });
    expect(event?.eventId).not.toBe(normalizeCursorHook(started, { receivedAt })[0]?.eventId);
    // 同一轮重复弹出提问框只算一次待确认。
    expect(normalizeCursorHook({ ...question }, { receivedAt: '2026-10-21T02:00:00.000Z' })[0]?.eventId).toBe(event?.eventId);
    // 两种公开写法都识别，大小写不敏感。
    expect(normalizeCursorHook({ ...question, tool_name: 'ask_question_tool_call' })[0]?.eventType).toBe('task.waiting_human');
    // 其他工具的 preToolUse 不是等待用户，不产生事件。
    for (const tool_name of ['Shell', 'Read', 'Write', 'questionnaire'])
      expect(normalizeCursorHook({ ...question, tool_name })).toEqual([]);
    expect(normalizeCursorHook({ ...question, tool_name: undefined })).toEqual([]);
  });

  it('复制配置只观察开始、提问与结束，不携带自动继续字段', () => {
    expect(cursorHookDescriptor).toMatchObject({ toolId: 'cursor', mode: 'turn', phases: ['beforeSubmitPrompt', 'preToolUse', 'stop'] });
    const command = '"/tmp/Synthetic Monitor.app/Contents/MacOS/Monitor" --tool-hook cursor';
    const config = JSON.parse(cursorHookSnippet(command));
    expect(config).toEqual({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command, type: 'command', timeout: 3, failClosed: false }],
        preToolUse: [{ command, type: 'command', timeout: 3, failClosed: false }],
        stop: [{ command, type: 'command', timeout: 3, failClosed: false }],
      },
    });
    expect(cursorHookSnippet(command)).not.toContain('followup_message');
    expect(JSON.parse(cursorHookSnippet(command, { timeoutSeconds: 1.5 })).hooks.stop[0].timeout).toBe(1.5);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('拒绝不合法的 hook timeout %s', (timeoutSeconds) => {
    expect(() => cursorHookSnippet('/tmp/synthetic-monitor --tool-hook cursor', { timeoutSeconds })).toThrow('timeout');
  });

  it('拒绝空启动命令', () => {
    expect(() => cursorHookSnippet(' ')).toThrow('不能为空');
  });
});
