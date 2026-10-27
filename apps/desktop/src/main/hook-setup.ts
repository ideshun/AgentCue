/** Official lifecycle hooks are configured by the user; MCP connection alone is not event capture. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  claudeCodeHookSnippet,
  clineHookScripts,
  codebuddyHookSnippet,
  cursorHookSnippet,
} from '@awm/adapters';
import { standardEventSchema, type StandardEvent } from '@awm/schema';
import type { DesktopMcpLaunch } from './mcp-launch';

export const HOOK_TOOLS = {
  // Claude Code 为主接入工具，排在首位。reopenOnStart：会话身份跨轮次复用，
  // 新任务开始前要把上一轮终态记录静默归档回 idle（引擎按此标志处理，不认识工具名）。
  'claude-code': { name: 'Claude Code', mode: 'turn', reopenOnStart: true },
  cursor: { name: 'Cursor', mode: 'turn' },
  cline: { name: 'Cline', mode: 'session' },
  codebuddy: { name: 'CodeBuddy', mode: 'session' },
} as const;
export type HookToolId = keyof typeof HOOK_TOOLS;

export interface HookIntegration {
  id: HookToolId;
  name: string;
  files: Array<{ path: string; content: string; executable?: boolean }>;
  steps: string[];
  commandReady: boolean;
  lastEventAt: string | null;
  enabled: boolean;
  capabilityReason: string;
}

/** @description: Quote fixed app paths and arguments for the local POSIX hook shell. */
function quoteShell(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** @description: Reuse the actual desktop executable while selecting the lightweight hook entry. */
export function toolHookCommand(
  launch: DesktopMcpLaunch | undefined,
  toolId: HookToolId,
  platform: NodeJS.Platform = process.platform,
): { command: string; ready: boolean } {
  if (!launch || !path.isAbsolute(launch.command)) return { command: '', ready: false };
  const args = [...launch.args];
  if (args.at(-1) !== '--mcp-stdio') return { command: '', ready: false };
  args.splice(-1, 1, '--tool-hook', toolId);
  return {
    command: [launch.command, ...args].map(quoteShell).join(' '),
    ready: platform !== 'win32' && existsSync(launch.command) && launch.commandReady,
  };
}

/** @description: Provide copyable files and observed event time without reading client configuration. */
export function hookIntegrations(
  launch: DesktopMcpLaunch | undefined,
  status: (id: HookToolId) => { lastEventAt: string | null; enabled: boolean },
): HookIntegration[] {
  return (Object.keys(HOOK_TOOLS) as HookToolId[]).map((id) => {
    const { command, ready } = toolHookCommand(launch, id);
    const common = [
      '保持 AgentCue 桌面应用运行，并开启本地来源读取；被忽略的工具不接收任务事件。',
      '配置由你粘贴；保留已有设置、Hooks 和脚本，不覆盖其他逻辑。',
      '配置后发送一个新任务，观察下方最近事件时间；收到开始或结束后才表示任务播报已接入。',
    ];
    let files: HookIntegration['files'] = [];
    let steps: string[];
    if (id === 'claude-code') {
      files = command
        ? [{ path: '~/.claude/settings.json', content: claudeCodeHookSnippet(command) }]
        : [];
      steps = [
        ...common,
        '将 hooks 合并进用户级 ~/.claude/settings.json；保留已有事件与 matcher，不要覆盖其他 Hooks。',
        '重新打开 Claude Code 会话后发送一个新任务；会话身份取自 transcript 路径，与文件采集一致。',
      ];
    } else if (id === 'cursor') {
      files = command
        ? [{ path: '~/.cursor/hooks.json', content: cursorHookSnippet(command) }]
        : [];
      steps = [...common, '合并 hooks.json 后，重新加载 Cursor 窗口；适用于自带 Agent / 聊天。'];
    } else if (id === 'codebuddy') {
      files = command
        ? [{ path: '~/.codebuddy/settings.json', content: codebuddyHookSnippet(command) }]
        : [];
      steps = [
        ...common,
        '将 hooks 合并进 CodeBuddy 的用户设置；如项目设置覆盖它，则合并到项目 .codebuddy/settings.json，再重新加载 Agent。',
      ];
    } else {
      files = command ? clineHookScripts(command) : [];
      steps = [
        ...common,
        '在 Cline Feature Settings 中启用 Hooks；将三个脚本分别保存到显示的路径。',
        '在终端对脚本执行 chmod u+x，赋予当前用户执行权限；已有同名脚本时合并调用。',
      ];
    }
    return {
      id,
      name: HOOK_TOOLS[id].name,
      files,
      steps,
      commandReady: ready && existsSync(path.join(__dirname, 'tool-hook-client.js')),
      ...status(id),
      capabilityReason:
        id === 'claude-code'
          ? '开始与完成来自 UserPromptSubmit / Stop；Notification 的 permission_prompt 视为等待确认。批准本身只通过之后的开始或完成事件间接观察。'
          : id === 'cursor'
            ? '开始与结束来自 beforeSubmitPrompt / stop；Agent 弹出提问框时 preToolUse 携带 AskQuestion 工具，据此播报待确认。'
            : '官方 Hooks 接收任务开始和结束；当前已验证接口不提供可靠的待确认事件。',
    };
  });
}

/**
 * @description: Claude Code 会话身份仅允许派生格式：哈希兜底，或文件适配器的
 * `claude-code:{project}:{key}`（可带 `:turn:` 分段）。各段只允许清理后的字符，总长受控。
 */
const CLAUDE_CODE_SESSION_ID =
  /^claude-code:(?:hooks:[a-f0-9]{64}|(?!hooks:)[^\s:]{1,128}:[^\s:]{1,128}(?::turn:[^\s:]{1,256})?)$/;

/** @description: Accept only minimal events from the supported hook protocols, never arbitrary task writes. */
export function parseHookEnvelope(input: Record<string, unknown>): {
  mode: 'turn' | 'session';
  event: StandardEvent;
} {
  const event = standardEventSchema.parse(input.event);
  if (!Object.hasOwn(HOOK_TOOLS, event.toolId)) throw new RangeError('工具不支持任务 Hooks');
  const tool = event.toolId as HookToolId;
  const explicitTurn = event.sessionId.includes(':turn:');
  const mode =
    tool === 'claude-code' || tool === 'cursor' || (tool === 'codebuddy' && explicitTurn)
      ? 'turn'
      : 'session';
  const allowed =
    tool === 'cursor'
      ? ['task.started', 'task.completed', 'task.cancelled', 'task.failed', 'task.waiting_human']
      : tool === 'cline'
        ? ['task.started', 'task.completed', 'task.cancelled']
        : tool === 'claude-code'
          ? ['task.started', 'task.completed', 'task.waiting_human']
          : ['task.started', 'task.completed'];
  const identityValid =
    tool === 'claude-code'
      ? event.sessionId.length <= 512 && CLAUDE_CODE_SESSION_ID.test(event.sessionId)
      : event.sessionId.startsWith(`${tool}:hooks:`);
  if (
    input.mode !== mode ||
    event.actor !== 'tool' ||
    !/^evt_hook_[a-f0-9]{64}$/.test(event.eventId) ||
    !identityValid ||
    event.sessionId.length > 2048 ||
    // Claude Code 会话身份本身就是文件适配器的任务身份，不要求额外的 turn 分段。
    (tool !== 'claude-code' && mode === 'turn' && !explicitTurn) ||
    (mode === 'session' && explicitTurn) ||
    !allowed.includes(event.eventType)
  )
    throw new RangeError('任务 Hook 事件无效');
  const title = event.payload.taskTitle?.trim();
  return {
    mode,
    event: {
      ...event,
      payload: title ? { taskTitle: Array.from(title).slice(0, 40).join('') } : {},
    },
  };
}
