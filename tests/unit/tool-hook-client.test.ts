import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { runToolHookCli, type ToolHookDependencies } from '../../apps/desktop/src/main/tool-hook-client';

const receivedAt = '2026-10-21T00:00:00.000Z';
const runtime = { apiPort: 45678, token: 'synthetic-token-never-log', pid: 1, startedAt: receivedAt };
const cursorStart = {
  conversation_id: 'synthetic-conversation', generation_id: 'turn-1',
  hook_event_name: 'beforeSubmitPrompt', prompt: '修复登录表单',
  user_email: 'synthetic@example.invalid', transcript_path: '/tmp/never-read-private-input',
};

function harness(tool: string, injected: ToolHookDependencies = {}, phase?: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const readRuntime = vi.fn(() => runtime);
  const args = ['synthetic-executable', '--tool-hook', tool];
  if (phase) args.push('--hook-phase', phase);
  const dependencies: ToolHookDependencies = {
    input, output, fetch: fetcher, readRuntime,
    now: () => new Date(receivedAt), timeoutMs: 100,
    ...injected,
  };
  return {
    input, output, fetcher, readRuntime,
    text: () => text,
    run: (body?: unknown) => {
      const done = runToolHookCli(args, dependencies);
      if (body !== undefined) input.end(typeof body === 'string' ? body : JSON.stringify(body));
      return done;
    },
  };
}

function sent(hook: ReturnType<typeof harness>) {
  const [url, options] = hook.fetcher.mock.calls[0]!;
  return { url, options, payload: JSON.parse(String(options?.body)) };
}

describe('观察型工具 hook CLI', () => {
  it('仅向固定 loopback 路径投递最小 Cursor 标准事件并放行一次', async () => {
    const hook = harness('cursor');
    await hook.run(cursorStart);
    expect(hook.fetcher).toHaveBeenCalledTimes(1);
    const request = sent(hook);
    expect(request.url).toBe('http://127.0.0.1:45678/api/v1/integrations/hooks');
    expect(request.options).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer synthetic-token-never-log' } });
    expect(request.payload).toMatchObject({ mode: 'turn', event: { toolId: 'cursor', eventType: 'task.started', occurredAt: receivedAt, payload: { taskTitle: '修复登录表单' } } });
    expect(Object.keys(request.payload).sort()).toEqual(['event', 'mode']);
    expect(request.payload.event.payload).toEqual({ taskTitle: '修复登录表单' });
    expect(JSON.stringify(request.payload)).not.toContain(cursorStart.transcript_path);
    expect(hook.text()).toBe('{"continue":true}\n');
    expect(hook.input.listenerCount('data')).toBe(0);
  });

  it.each([undefined, 'request-1'])('CodeBuddy 根据已验证的可选 generation_id=%s 选择会话或逐轮模式', async (generation_id) => {
    const hook = harness('codebuddy');
    await hook.run({ session_id: 'session-demo', generation_id, hook_event_name: 'UserPromptSubmit', prompt: '布局优化', cwd: '/tmp/private-project' });
    expect(sent(hook).payload.mode).toBe(generation_id ? 'turn' : 'session');
    expect(sent(hook).payload.event.payload).toEqual({ taskTitle: '布局优化' });
    expect(hook.text()).toBe('{"continue":true,"suppressOutput":true}\n');
  });

  it('Cline 使用原生 hookName/timestamp，统一会话模式且输出 cancel:false', async () => {
    const hook = harness('cline', {}, 'TaskStart');
    await hook.run({ taskId: 'synthetic-task', timestamp: String(Date.parse(receivedAt) - 1000), hookName: 'TaskStart', taskStart: { taskMetadata: { initialTask: '完善表格' } } });
    expect(sent(hook).payload).toMatchObject({ mode: 'session', event: { toolId: 'cline', eventType: 'task.started', occurredAt: '2026-10-20T23:59:59.000Z', payload: { taskTitle: '完善表格' } } });
    expect(hook.text()).toBe('{"cancel":false}\n');
  });

  it('Claude Code 使用逐轮模式、会话身份取自 transcript 路径且只输出空 JSON 对象', async () => {
    const hook = harness('claude-code');
    await hook.run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'synthetic-claude-session',
      prompt_id: 'prompt-1',
      transcript_path: '/tmp/home/.claude/projects/demo-project/sess-1.jsonl',
      cwd: '/tmp/private-project',
      prompt: '优化表格布局',
    });
    expect(hook.fetcher).toHaveBeenCalledTimes(1);
    expect(sent(hook).payload).toMatchObject({
      mode: 'turn',
      event: {
        toolId: 'claude-code',
        eventType: 'task.started',
        sessionId: 'claude-code:demo-project:sess-1',
        occurredAt: receivedAt,
        payload: { taskTitle: '优化表格布局' },
      },
    });
    expect(JSON.stringify(sent(hook).payload)).not.toContain('/tmp/home');
    expect(hook.text()).toBe('{}\n');
  });

  it('Claude Code 等待确认同样输出 {}，未知通知类型不投递', async () => {
    const hook = harness('claude-code');
    await hook.run({
      hook_event_name: 'Notification',
      session_id: 'synthetic-claude-session',
      notification_type: 'permission_prompt',
      message: 'never forwarded',
    });
    expect(sent(hook).payload).toMatchObject({
      mode: 'turn',
      event: { eventType: 'task.waiting_human', payload: {} },
    });
    expect(hook.text()).toBe('{}\n');
    const ignored = harness('claude-code');
    await ignored.run({
      hook_event_name: 'Notification',
      session_id: 'synthetic-claude-session',
      notification_type: 'idle_prompt',
    });
    expect(ignored.fetcher).not.toHaveBeenCalled();
    expect(ignored.text()).toBe('{}\n');
  });

  it('Cursor stop 返回空对象，不添加自动继续或上下文', async () => {
    const hook = harness('cursor');
    await hook.run({ ...cursorStart, hook_event_name: 'stop', status: 'completed' });
    expect(sent(hook).payload.event.payload).toEqual({});
    expect(hook.text()).toBe('{}\n');
  });

  it('失败异常不会泄漏原始输入、token 或 HTTP 错误正文，不重试', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`private error ${runtime.token} ${cursorStart.transcript_path}`));
    const hook = harness('cursor', { fetch: fetcher });
    await hook.run(cursorStart);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hook.text()).toBe('{"continue":true}\n');
    expect(hook.text()).not.toContain(runtime.token);
    expect(hook.text()).not.toContain('private');
  });

  it.each([null, { ...runtime, apiPort: 0 }, { ...runtime, apiPort: 65536 }, { ...runtime, apiPort: 1.5 }, { ...runtime, token: ' ' }, { ...runtime, token: 'invalid\r\nheader' }])('未运行或运行时字段非法时不发起 HTTP %#', async (value) => {
    const hook = harness('cursor', { readRuntime: () => value });
    await hook.run(cursorStart);
    expect(hook.fetcher).not.toHaveBeenCalled();
    expect(hook.text()).toBe('{"continue":true}\n');
  });

  it('输入超过1MiB时释放监听、停止读取并按显式阶段放行', async () => {
    const hook = harness('cursor', {}, 'beforeSubmitPrompt');
    await hook.run('x'.repeat(1024 * 1024 + 1));
    expect(hook.fetcher).not.toHaveBeenCalled();
    expect(hook.text()).toBe('{"continue":true}\n');
    expect(hook.input.listenerCount('data')).toBe(0);
    expect(hook.input.listenerCount('end')).toBe(0);
    expect(hook.input.isPaused()).toBe(true);
  });

  it('stdin 不结束时在总期限内返回并清理监听', async () => {
    const hook = harness('cursor', { timeoutMs: 20 }, 'beforeSubmitPrompt');
    const began = Date.now();
    await hook.run();
    expect(Date.now() - began).toBeLessThan(500);
    expect(hook.input.listenerCount('data')).toBe(0);
    expect(hook.input.listenerCount('error')).toBe(0);
    expect(hook.input.isPaused()).toBe(true);
    expect(hook.text()).toBe('{"continue":true}\n');
    expect(hook.fetcher).not.toHaveBeenCalled();
  });

  it('HTTP 挂起时截止返回并中止请求，不排队重试', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const hook = harness('cursor', { fetch: fetcher, timeoutMs: 20 });
    await hook.run(cursorStart);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(hook.text()).toBe('{"continue":true}\n');
  });

  it('运行时查询超时后即使稍晚恢复也不再发起请求', async () => {
    let resolveRuntime!: (value: typeof runtime) => void;
    const pending = new Promise<typeof runtime>((resolve) => { resolveRuntime = resolve; });
    const hook = harness('cursor', { readRuntime: () => pending, timeoutMs: 20 });
    await hook.run(cursorStart);
    resolveRuntime(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hook.fetcher).not.toHaveBeenCalled();
    expect(hook.text()).toBe('{"continue":true}\n');
  });

  it('无效JSON与阶段冲突均放行，不把解析错误注入 Agent', async () => {
    const malformed = harness('codebuddy');
    await malformed.run('invalid synthetic JSON');
    expect(malformed.text()).toBe('{"continue":true,"suppressOutput":true}\n');
    expect(malformed.fetcher).not.toHaveBeenCalled();
    const mismatch = harness('cursor', {}, 'beforeSubmitPrompt');
    await mismatch.run({ ...cursorStart, hook_event_name: 'stop', status: 'completed' });
    expect(mismatch.text()).toBe('{"continue":true}\n');
    expect(mismatch.fetcher).not.toHaveBeenCalled();
  });

  it('Cursor 未知阶段安全返回空对象，不发送伪事件', async () => {
    const hook = harness('cursor');
    await hook.run({ ...cursorStart, hook_event_name: 'afterAgentResponse' });
    expect(hook.text()).toBe('{}\n');
    expect(hook.readRuntime).not.toHaveBeenCalled();
  });
});

describe('轻量 entry 分派', () => {
  const source = readFileSync(path.join(process.cwd(), 'apps/desktop/src/main/entry.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

  it('先执行 hook 分支，不导入桌面 bootstrap 或 SQLite', async () => {
    const imports: string[] = [];
    const run = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const argv = ['synthetic-electron', 'synthetic-app', '--tool-hook', 'cursor'];
    vm.runInNewContext(compiled, {
      exports: {}, __dirname: '/tmp/synthetic-entry', setTimeout, clearTimeout,
      process: { argv, exit, stdout: { write: vi.fn() } },
      require: (id: string) => {
        imports.push(id);
        if (id === 'node:path') return path;
        if (id === './tool-hook-client') return { runToolHookCli: run };
        throw new Error(`Unexpected module: ${id}`);
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(imports).toEqual(['node:path', './tool-hook-client']);
    expect(run).toHaveBeenCalledWith(argv);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each([
    ['claude-code', '{}\n'],
    ['cline', '{"cancel":false}\n'],
    ['codebuddy', '{"continue":true,"suppressOutput":true}\n'],
  ])('hook 模块加载失败也仅输出 %s 放行JSON且退出0', async (tool, expected) => {
    let text = '';
    const exit = vi.fn();
    vm.runInNewContext(compiled, {
      exports: {}, __dirname: '/tmp/synthetic-entry', setTimeout, clearTimeout,
      process: {
        argv: ['synthetic', '--tool-hook', tool], exit,
        stdout: { write: (chunk: string, callback: () => void) => { text += chunk; callback(); } },
      },
      require: (id: string) => {
        if (id === 'node:path') return path;
        throw new Error('private dependency error never log');
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(text).toBe(expected);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
