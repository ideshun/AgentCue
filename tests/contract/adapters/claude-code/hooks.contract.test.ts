import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeCodeHookDescriptor,
  claudeCodeHookSnippet,
  normalizeClaudeCodeHook,
} from '@awm/adapters';

/** 全部使用官方文档字段形状和自造值；不读取真实 transcript、设置或用户目录。 */
const transcript = '/tmp/synthetic-home/.claude/projects/-tmp-synthetic-project/sess-1.jsonl';
const common = {
  session_id: 'synthetic-claude-session',
  prompt_id: 'prompt-1',
  transcript_path: transcript,
  cwd: '/tmp/synthetic-project',
  permission_mode: 'default',
};
const started = { ...common, hook_event_name: 'UserPromptSubmit', prompt: '修复登录流程' };
const stopped = {
  ...common,
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: '助手正文不参与标题',
};
const notification = {
  ...common,
  hook_event_name: 'Notification',
  message: 'Claude needs your permission to use Bash',
  title: 'Permission needed',
  notification_type: 'permission_prompt',
};
const receivedAt = '2026-10-22T00:00:00.000Z';

describe('Claude Code hooks 契约', () => {
  it('UserPromptSubmit 只产出身份、阶段和用户标题', () => {
    const [event] = normalizeClaudeCodeHook(started, { receivedAt });
    expect(event).toMatchObject({
      sessionId: 'claude-code:-tmp-synthetic-project:sess-1',
      toolId: 'claude-code',
      eventType: 'task.started',
      occurredAt: receivedAt,
      actor: 'tool',
      payload: { taskTitle: '修复登录流程' },
      schemaVersion: 1,
    });
    expect(Object.keys(event ?? {}).sort()).toEqual([
      'actor',
      'eventId',
      'eventType',
      'occurredAt',
      'payload',
      'schemaVersion',
      'sessionId',
      'toolId',
    ]);
    expect(event?.eventId).toMatch(/^evt_hook_[a-f0-9]{64}$/);
    expect(event?.payload).toEqual({ taskTitle: '修复登录流程' });
  });

  it('会话身份与 JSONL 文件适配器一致，Windows 分隔符同样适用', () => {
    const [posix] = normalizeClaudeCodeHook(started, { receivedAt });
    const project = path.basename(path.dirname(transcript));
    const sessionKey = path.basename(transcript, path.extname(transcript));
    expect(posix?.sessionId).toBe(`claude-code:${project}:${sessionKey}`);

    const [windows] = normalizeClaudeCodeHook(
      {
        ...started,
        transcript_path: 'C:\\Users\\synthetic\\.claude\\projects\\demo-proj\\sess-9.jsonl',
      },
      { receivedAt },
    );
    expect(windows?.sessionId).toBe('claude-code:demo-proj:sess-9');
    // 与 Start / Stop / 待确认三类事件共用同一任务行。
    const [stop] = normalizeClaudeCodeHook(stopped, { receivedAt });
    const [waiting] = normalizeClaudeCodeHook(notification, { receivedAt });
    expect(stop?.sessionId).toBe(posix?.sessionId);
    expect(waiting?.sessionId).toBe(posix?.sessionId);
  });

  it('事件 ID 不含正文与路径，重复投递稳定，换 prompt_id 才算新一轮', () => {
    const first = normalizeClaudeCodeHook(started, { receivedAt })[0]!;
    const duplicate = normalizeClaudeCodeHook(
      { ...started, prompt: '重复投递的不同正文', cwd: '/tmp/other', title: '注入字段' },
      { receivedAt: '2026-10-22T01:00:00.000Z' },
    )[0]!;
    const nextPrompt = normalizeClaudeCodeHook(
      { ...started, prompt_id: 'prompt-2' },
      { receivedAt },
    )[0]!;
    const stop = normalizeClaudeCodeHook(stopped, { receivedAt })[0]!;
    expect(duplicate.eventId).toBe(first.eventId);
    expect(nextPrompt.eventId).not.toBe(first.eventId);
    expect(stop.eventId).not.toBe(first.eventId);
    expect(first.eventId).not.toContain('synthetic-claude-session');
    expect([first, stop, nextPrompt].map((event) => event.eventId).join()).not.toContain(
      transcript,
    );
    expect(stop.eventId).not.toContain(started.prompt);
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    42,
    'sess-1.jsonl',
    '/tmp/synthetic-home/.claude/projects/',
  ])('transcript_path 缺失或不可解析时回退到散列身份 %#', (transcript_path) => {
    const [event] = normalizeClaudeCodeHook({ ...started, transcript_path }, { receivedAt });
    expect(event?.sessionId).toMatch(/^claude-code:hooks:[a-f0-9]{64}$/);
    expect(event?.sessionId).not.toContain(common.session_id);
    expect(
      normalizeClaudeCodeHook({ ...stopped, transcript_path }, { receivedAt })[0]?.sessionId,
    ).toBe(event?.sessionId);
  });

  it('Stop 只表示完成，不采用 last_assistant_message 或 stop_hook_active', () => {
    const [event] = normalizeClaudeCodeHook(
      { ...stopped, status: 'error', error: 'synthetic', cancelled: true },
      { receivedAt },
    );
    expect(event?.eventType).toBe('task.completed');
    expect(event?.payload).toEqual({});
  });

  it('permission_prompt 通知映射为等待确认，其他通知类型不产生事件', () => {
    const [event] = normalizeClaudeCodeHook(notification, { receivedAt });
    expect(event?.eventType).toBe('task.waiting_human');
    expect(event?.payload).toEqual({});
    expect(JSON.stringify(event)).not.toContain(notification.message);
    expect(JSON.stringify(event)).not.toContain(notification.title);
    expect(
      normalizeClaudeCodeHook(
        { ...notification, notification_type: 'idle_prompt' },
        { receivedAt },
      ),
    ).toEqual([]);
    expect(
      normalizeClaudeCodeHook({ ...notification, notification_type: undefined }, { receivedAt }),
    ).toEqual([]);
  });

  it.each([
    'SessionStart',
    'SessionEnd',
    'PreToolUse',
    'PostToolUse',
    'SubagentStop',
    'PreCompact',
  ])('不把 %s 猜成任务状态', (hook_event_name) => {
    expect(normalizeClaudeCodeHook({ ...common, hook_event_name })).toEqual([]);
  });

  it('标题最多40字符且只取用户请求文本', () => {
    const title = normalizeClaudeCodeHook(
      { ...started, prompt: '任务'.repeat(30) },
      { receivedAt },
    )[0]?.payload.taskTitle;
    expect(Array.from(title ?? '')).toHaveLength(40);
    expect(
      normalizeClaudeCodeHook({ ...started, prompt: '{"risk_level":"low"}' }, { receivedAt })[0]
        ?.payload,
    ).toEqual({ taskTitle: '{"risk_level":"low"}' });
    expect(
      normalizeClaudeCodeHook(
        { ...started, prompt: '<environment_context>内部环境</environment_context>' },
        { receivedAt },
      )[0]?.payload,
    ).toEqual({});
  });

  it('显式 phase 可补缺失名称，但不得与 hook_event_name 冲突', () => {
    const payload: Partial<typeof started> = { ...started };
    delete payload.hook_event_name;
    expect(normalizeClaudeCodeHook(payload, { phase: 'UserPromptSubmit', receivedAt })).toEqual(
      normalizeClaudeCodeHook(started, { receivedAt }),
    );
    expect(() => normalizeClaudeCodeHook(stopped, { phase: 'UserPromptSubmit' })).toThrow('不一致');
  });

  it.each([null, [], 'invalid json', 42])('拒绝非对象输入 %#', (input) => {
    expect(() => normalizeClaudeCodeHook(input)).toThrow('JSON 对象');
  });

  it.each([
    { session_id: '' },
    { session_id: ' ' },
    { session_id: null },
    { prompt: null },
    { hook_event_name: 1 },
  ])('拒绝无效字段 %#', (patch) => {
    expect(() => normalizeClaudeCodeHook({ ...started, ...patch }, { receivedAt })).toThrow();
  });

  it('缺少阶段或接收时间非法时不产生事件', () => {
    expect(() => normalizeClaudeCodeHook({ ...common, prompt: '用户请求' })).toThrow(
      'hook_event_name',
    );
    expect(() => normalizeClaudeCodeHook(started, { receivedAt: 'invalid-date' })).toThrow();
  });

  it('settings.json 片段包含三个观察事件与 permission_prompt matcher', () => {
    const command = '"/tmp/Synthetic Monitor.app/Contents/MacOS/Monitor" --tool-hook claude-code';
    const hook = { type: 'command', command, timeout: 10 };
    expect(JSON.parse(claudeCodeHookSnippet(command))).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [hook] }],
        Stop: [{ hooks: [hook] }],
        Notification: [{ matcher: 'permission_prompt', hooks: [hook] }],
      },
    });
    expect(
      JSON.parse(claudeCodeHookSnippet(command, { timeoutSeconds: 1.5 })).hooks.Notification[0]
        .hooks[0].timeout,
    ).toBe(1.5);
    expect(claudeCodeHookDescriptor).toMatchObject({
      toolId: 'claude-code',
      mode: 'turn',
      phases: ['UserPromptSubmit', 'Stop', 'Notification'],
      configPath: '~/.claude/settings.json',
      documentationUrl: 'https://code.claude.com/docs/en/hooks',
    });
    expect(claudeCodeHookSnippet(command)).not.toContain('failClosed');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '拒绝无效 timeout %s',
    (timeoutSeconds) => {
      expect(() =>
        claudeCodeHookSnippet('/tmp/monitor --tool-hook claude-code', { timeoutSeconds }),
      ).toThrow('timeout');
    },
  );

  it('拒绝空启动命令', () => {
    expect(() => claudeCodeHookSnippet(' ')).toThrow('不能为空');
  });
});
