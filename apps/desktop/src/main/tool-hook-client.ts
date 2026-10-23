/** 观察型 hooks 子进程：有界读取、单次投递，任何失败均放行编辑器。 */
import type { Readable, Writable } from 'node:stream';
import { readRuntimeInfo, type RuntimeInfo } from '@awm/core';
import {
  normalizeClaudeCodeHook,
  normalizeClineHook,
  normalizeCodeBuddyHook,
  normalizeCursorHook,
  type ClaudeCodeHookPhase,
  type ClineHookPhase,
  type CodeBuddyHookPhase,
  type CursorHookPhase,
} from '@awm/adapters';
import type { StandardEvent } from '@awm/schema';

export type HookTool = 'claude-code' | 'cursor' | 'cline' | 'codebuddy';

export interface ToolHookDependencies {
  input?: Readable;
  output?: Pick<Writable, 'write'>;
  readRuntime?: () => RuntimeInfo | null | Promise<RuntimeInfo | null>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
}

const MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 1750;

/** @description: 超时或失败时注销自己的监听并暂停 stdin，不销毁调用者的流。 */
function readHookInput(input: Readable, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = (): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      input.pause();
    };
    const fail = (): void => {
      cleanup();
      reject(new Error('Hook input unavailable'));
    };
    const onData = (data: Buffer | string): void => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      total += chunk.byteLength;
      if (total > MAX_INPUT_BYTES) {
        fail();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, total).toString('utf8'));
    };
    const onError = (): void => fail();
    const onAbort = (): void => fail();
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted || input.destroyed) fail();
    else if (input.readableEnded) onEnd();
    else input.resume();
  });
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function nativePhase(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const payload = input as Record<string, unknown>;
  return typeof payload.hook_event_name === 'string' ? payload.hook_event_name : undefined;
}

function acknowledgment(tool: string | undefined, phase: string | undefined): object {
  if (tool === 'cline') return { cancel: false };
  // CodeBuddy IDE 会把未 suppress 的 UserPromptSubmit stdout 注入 Agent 上下文。
  if (tool === 'codebuddy') return { continue: true, suppressOutput: true };
  // Claude Code 同样会注入 UserPromptSubmit 的纯文本 stdout，所有阶段都只输出空 JSON 对象。
  if (tool === 'claude-code') return {};
  return tool === 'cursor' && phase === 'beforeSubmitPrompt' ? { continue: true } : {};
}

function normalize(tool: HookTool, input: unknown, phase: string | undefined, receivedAt: string): StandardEvent[] {
  if (tool === 'claude-code')
    return normalizeClaudeCodeHook(input, {
      phase: phase as ClaudeCodeHookPhase | undefined,
      receivedAt,
    });
  if (tool === 'cursor')
    return normalizeCursorHook(input, { phase: phase as CursorHookPhase | undefined, receivedAt });
  if (tool === 'codebuddy')
    return normalizeCodeBuddyHook(input, { phase: phase as CodeBuddyHookPhase | undefined, receivedAt });
  return normalizeClineHook(input, {
    phase: phase as ClineHookPhase | undefined,
    receivedAt,
  });
}

/** @description: 不重试、不排队；总时限覆盖 stdin、运行时查询与 HTTP。输出只含原生放行字段。 */
export async function runToolHookCli(
  argv: readonly string[] = process.argv,
  dependencies: ToolHookDependencies = {},
): Promise<void> {
  const tool = argument(argv, '--tool-hook');
  const explicitPhase = argument(argv, '--hook-phase');
  let phase = explicitPhase;
  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const controller = new AbortController();
  const requestedTimeout = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(2000, requestedTimeout)) : DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, timeoutMs);
  });
  const work = async (): Promise<void> => {
    if (tool !== 'claude-code' && tool !== 'cursor' && tool !== 'cline' && tool !== 'codebuddy')
      return;
    const receivedAt = (dependencies.now?.() ?? new Date()).toISOString();
    const raw = await readHookInput(input, controller.signal);
    if (controller.signal.aborted) return;
    const payload: unknown = JSON.parse(raw);
    phase = explicitPhase ?? nativePhase(payload);
    const events = normalize(tool, payload, explicitPhase, receivedAt);
    if (events.length === 0) return;
    const runtime = await (dependencies.readRuntime ?? readRuntimeInfo)();
    if (controller.signal.aborted || !runtime || !Number.isInteger(runtime.apiPort) ||
      runtime.apiPort < 1 || runtime.apiPort > 65535 || !runtime.token.trim() ||
      /[\r\n]/.test(runtime.token)) return;
    const fetcher = dependencies.fetch ?? globalThis.fetch;
    for (const event of events) {
      if (controller.signal.aborted) return;
      const mode = tool === 'claude-code' || tool === 'cursor' ||
        (tool === 'codebuddy' && event.sessionId.includes(':turn:'))
        ? 'turn' : 'session';
      const response = await fetcher(`http://127.0.0.1:${runtime.apiPort}/api/v1/integrations/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.token}` },
        body: JSON.stringify({ mode, event }),
        signal: controller.signal,
      });
      // 不读取响应正文，避免把服务器异常或正文带回 IDE 上下文。
      await response.body?.cancel();
      if (!response.ok) return;
    }
  };
  try {
    await Promise.race([work().catch(() => undefined), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    await new Promise<void>((resolve) => {
      const flushTimer = setTimeout(resolve, 20);
      const flushed = (): void => { clearTimeout(flushTimer); resolve(); };
      try {
        output.write(`${JSON.stringify(acknowledgment(tool, phase))}\n`, flushed);
      } catch {
        // stdout 已关闭时同样结束，不输出任何原始异常、输入或凭据。
        flushed();
      }
    });
  }
}
