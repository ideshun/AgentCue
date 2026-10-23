/** Copyable configuration and ingress validation use synthetic metadata only. */
import { describe, expect, it } from 'vitest';
import {
  normalizeClaudeCodeHook,
  normalizeCodeBuddyHook,
  normalizeCursorHook,
  normalizeClineHook,
} from '@awm/adapters';
import {
  hookIntegrations,
  parseHookEnvelope,
  toolHookCommand,
} from '../../apps/desktop/src/main/hook-setup';

const receivedAt = '2026-10-21T04:00:00.000Z';
const cursor = () =>
  normalizeCursorHook(
    {
      hook_event_name: 'beforeSubmitPrompt',
      conversation_id: 'synthetic-conversation',
      generation_id: 'synthetic-turn',
      prompt: '修复登录模块',
    },
    { receivedAt },
  )[0]!;

describe('task hook configuration', () => {
  it('quotes executable and fixed arguments without exposing shell expansion', () => {
    const launch = toolHookCommand(
      {
        command: "/tmp/awm 'quoted' $(ignored)/App",
        args: ['/tmp/dev folder', '--mcp-stdio'],
        commandReady: true,
      },
      'cursor',
    );
    expect(launch.command).toBe(
      "'/tmp/awm '\\''quoted'\\'' $(ignored)/App' '/tmp/dev folder' '--tool-hook' 'cursor'",
    );
    expect(launch.ready).toBe(false);
    expect(
      toolHookCommand({ command: 'relative', args: ['--mcp-stdio'], commandReady: true }, 'cursor')
        .ready,
    ).toBe(false);
  });

  it('provides user-owned configuration files and observed event status for all four tools', () => {
    const setup = hookIntegrations(
      { command: '/tmp/Synthetic App', args: ['--mcp-stdio'], commandReady: false },
      (id) => ({ lastEventAt: id === 'cursor' ? receivedAt : null, enabled: id !== 'cline' }),
    );
    expect(setup.map((item) => item.id)).toEqual([
      'claude-code',
      'cursor',
      'cline',
      'codebuddy',
    ]);
    expect(setup[1]?.lastEventAt).toBe(receivedAt);
    expect(setup[0]?.lastEventAt).toBeNull();
    expect(setup[2]?.enabled).toBe(false);
    expect(setup[2]?.files).toHaveLength(3);
    expect(
      setup[2]?.files.every((file) => file.executable && file.content.startsWith('#!/bin/sh\n')),
    ).toBe(true);
    expect(setup.every((item) => !item.commandReady)).toBe(true);
    expect(JSON.parse(setup[1]!.files[0]!.content).hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(JSON.parse(setup[3]!.files[0]!.content).hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(
      3,
    );
    const claude = setup[0]!;
    expect(claude.name).toBe('Claude Code');
    expect(claude.files.map((file) => file.path)).toEqual(['~/.claude/settings.json']);
    const claudeConfig = JSON.parse(claude.files[0]!.content);
    expect(Object.keys(claudeConfig.hooks)).toEqual(['UserPromptSubmit', 'Stop', 'Notification']);
    expect(claudeConfig.hooks.Notification[0].matcher).toBe('permission_prompt');
    expect(claudeConfig.hooks.Notification[0].hooks[0].command).toContain('--tool-hook');
    expect(claude.capabilityReason).toContain('permission_prompt');
  });
});

describe('task hook ingress contract', () => {
  it('accepts validated Cursor events and strips all non-metadata payload fields', () => {
    const event = cursor();
    event.payload = {
      taskTitle: '字'.repeat(80),
      transcript_path: '/never-read',
      prompt: 'never-store',
    };
    const parsed = parseHookEnvelope({ mode: 'turn', event });
    expect(parsed.event.payload).toEqual({ taskTitle: '字'.repeat(40) });
    expect(parsed.mode).toBe('turn');
  });

  it('accepts the verified session-only Cline and legacy CodeBuddy protocols', () => {
    const cline = normalizeClineHook(
      {
        hookName: 'TaskStart',
        taskId: 'synthetic-task',
        timestamp: '1792555200000',
        taskStart: { taskMetadata: { initialTask: '合成任务' } },
      },
      { receivedAt },
    )[0]!;
    const buddy = normalizeCodeBuddyHook(
      { hook_event_name: 'UserPromptSubmit', session_id: 'synthetic-session', prompt: '合成任务' },
      { receivedAt },
    )[0]!;
    expect(parseHookEnvelope({ mode: 'session', event: cline }).event.toolId).toBe('cline');
    expect(parseHookEnvelope({ mode: 'session', event: buddy }).event.toolId).toBe('codebuddy');
    const currentBuddy = normalizeCodeBuddyHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'synthetic-session',
        generation_id: 'verified-ide-turn',
        prompt: '合成任务',
      },
      { receivedAt },
    )[0]!;
    expect(parseHookEnvelope({ mode: 'turn', event: currentBuddy }).event.toolId).toBe('codebuddy');
  });

  it('accepts Claude Code turn events keyed by the transcript-derived session', () => {
    const start = normalizeClaudeCodeHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'synthetic-claude-session',
        prompt_id: 'prompt-1',
        transcript_path: '/tmp/home/.claude/projects/demo-project/sess-1.jsonl',
        prompt: '合成任务',
      },
      { receivedAt },
    )[0]!;
    const waiting = normalizeClaudeCodeHook(
      {
        hook_event_name: 'Notification',
        session_id: 'synthetic-claude-session',
        prompt_id: 'prompt-1',
        notification_type: 'permission_prompt',
        message: 'never forwarded',
      },
      { receivedAt },
    )[0]!;
    expect(parseHookEnvelope({ mode: 'turn', event: start }).event).toMatchObject({
      toolId: 'claude-code',
      eventType: 'task.started',
      sessionId: 'claude-code:demo-project:sess-1',
      payload: { taskTitle: '合成任务' },
    });
    expect(parseHookEnvelope({ mode: 'turn', event: waiting }).mode).toBe('turn');
    expect(parseHookEnvelope({ mode: 'turn', event: waiting }).event.payload).toEqual({});
    const fallback = normalizeClaudeCodeHook(
      { hook_event_name: 'Stop', session_id: 'synthetic-claude-session' },
      { receivedAt },
    )[0]!;
    expect(parseHookEnvelope({ mode: 'turn', event: fallback }).event.sessionId).toMatch(
      /^claude-code:hooks:[a-f0-9]{64}$/,
    );
  });

  it.each([
    { sessionId: 'claude-code:project key:key' },
    { sessionId: 'claude-code:project' },
    { sessionId: 'claude-code:hooks:not-a-hash' },
    { sessionId: 'claude-code:project:key:turn:' },
    { sessionId: 'claude-code:project:key extra' },
    { sessionId: `claude-code:${'p'.repeat(129)}:key` },
    { toolId: 'cursor', sessionId: 'claude-code:project:key' },
    { eventType: 'task.cancelled', toolId: 'claude-code' },
    { eventType: 'task.failed', toolId: 'claude-code' },
    { actor: 'system', toolId: 'claude-code' },
    { eventId: 'evt_hook_synthetic_deadbeef' },
  ])('rejects unverified Claude Code writes (%j)', (patch) => {
    const event = normalizeClaudeCodeHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'synthetic-claude-session',
        prompt_id: 'prompt-1',
        transcript_path: '/tmp/home/.claude/projects/demo-project/sess-1.jsonl',
        prompt: '合成任务',
      },
      { receivedAt },
    )[0]!;
    expect(() =>
      parseHookEnvelope({
        mode: patch.toolId === 'cursor' ? 'session' : 'turn',
        event: { ...event, ...patch },
      }),
    ).toThrow();
  });

  it('rejects Claude Code events in session mode', () => {
    const event = normalizeClaudeCodeHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'synthetic-claude-session',
        prompt: '合成任务',
      },
      { receivedAt },
    )[0]!;
    expect(() => parseHookEnvelope({ mode: 'session', event })).toThrow();
  });

  it.each([
    { toolId: 'unknown' },
    { actor: 'mcp' },
    { eventId: 'evt_arbitrary' },
    { sessionId: 'unrelated-task' },
    { eventType: 'task.retried' },
  ])('rejects unverified hook writes (%j)', (patch) => {
    expect(() => parseHookEnvelope({ mode: 'turn', event: { ...cursor(), ...patch } })).toThrow();
  });

  it('accepts Cursor AskQuestion as waiting_human', () => {
    const event = normalizeCursorHook(
      {
        hook_event_name: 'preToolUse',
        conversation_id: 'conv',
        generation_id: 'gen',
        tool_name: 'AskQuestion',
      },
      { receivedAt },
    )[0]!;
    expect(parseHookEnvelope({ mode: 'turn', event }).event.eventType).toBe('task.waiting_human');
  });

  it('rejects incorrect identity modes and malformed requests', () => {
    expect(() => parseHookEnvelope({ mode: 'session', event: cursor() })).toThrow();
    expect(() => parseHookEnvelope({ mode: 'turn', event: null })).toThrow();
  });
});
