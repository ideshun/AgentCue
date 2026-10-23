/** Client-specific setup belongs to adapters; configurations are copied by the user. */
export interface McpSnippet {
  id: string;
  name: string;
  hint: string;
  /** Kept for existing consumers; format indicates JSON versus TOML. */
  json: string;
  format: 'json' | 'toml';
  steps: string[];
  commandReady: boolean;
}

export interface McpLaunchConfig {
  command: string;
  args?: string[];
  commandReady?: boolean;
}

/** @description: Generate copyable configuration and client instructions for the actual desktop launch path. */
export function mcpSnippets(launch: string | McpLaunchConfig = 'awm-mcp'): McpSnippet[] {
  const config =
    typeof launch === 'string'
      ? { command: launch, args: [] as string[], commandReady: false }
      : launch;
  const server = { type: 'stdio', command: config.command, args: config.args ?? [] };
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const common = [
    '保持 AI Workflow Monitor 桌面应用运行。',
    '将配置合并进现有 MCP 配置，保留其他服务条目。',
    '保存后在客户端刷新 MCP，确认出现 6 个 AWM 工具；在 AWM 中也可验证桥接。',
  ];
  const define = (
    id: string,
    name: string,
    hint: string,
    text: string,
    steps: string[],
    format: 'json' | 'toml' = 'json',
  ): McpSnippet => ({
    id,
    name,
    hint,
    json: text,
    format,
    steps: [common[0]!, ...steps, common[1]!, common[2]!],
    commandReady: config.commandReady === true,
  });
  return [
    define(
      'cursor',
      'Cursor',
      '~/.cursor/mcp.json 或项目 .cursor/mcp.json',
      json({ mcpServers: { 'ai-workflow-monitor': server } }),
      ['打开 Cursor Settings → Tools & Integrations → MCP，或编辑提示位置的配置文件。'],
    ),
    define(
      'cline',
      'Cline',
      'Cline 面板 → MCP Servers → Configure MCP Servers',
      json({
        mcpServers: {
          'ai-workflow-monitor': {
            command: server.command,
            args: server.args,
            disabled: false,
            autoApprove: [] as string[],
          },
        },
      }),
      ['在 Cursor 的 Cline 扩展中打开 MCP Servers → Configure → Configure MCP Servers。'],
    ),
    define(
      'codebuddy',
      'CodeBuddy',
      'CodeBuddy 设置 → MCP → 添加 MCP',
      json({
        mcpServers: {
          'ai-workflow-monitor': { type: 'stdio', command: server.command, args: server.args },
        },
      }),
      ['打开 CodeBuddy 的 MCP 设置，选择手动添加／JSON 配置。'],
    ),
    define(
      'claude-code',
      'Claude Code',
      '项目 .mcp.json',
      json({ mcpServers: { 'ai-workflow-monitor': server } }),
      [
        '在项目根目录打开或新建 .mcp.json。',
        '重新进入 Claude Code，并按客户端提示批准此 MCP 服务。',
      ],
    ),
    define(
      'claude-desktop',
      'Claude Desktop',
      'Settings → Developer → Edit Config',
      json({
        mcpServers: { 'ai-workflow-monitor': { command: server.command, args: server.args } },
      }),
      ['在 Claude Desktop 开发者设置中打开配置文件。'],
    ),
    define(
      'vscode',
      'VS Code',
      '.vscode/mcp.json',
      json({ servers: { 'ai-workflow-monitor': server } }),
      ['在项目的 .vscode/mcp.json 中添加 servers 条目。', '从 MCP 服务列表启动并信任 AWM。'],
    ),
    define(
      'codex',
      'Codex',
      '~/.codex/config.toml',
      `[mcp_servers.ai-workflow-monitor]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`,
      ['打开 Codex 的 config.toml，粘贴下方 TOML 配置段。'],
      'toml',
    ),
  ];
}
