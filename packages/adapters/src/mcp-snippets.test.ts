import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mcpSnippets } from './mcp-snippets';

describe('additional MCP clients', () => {
  it.each([
    '/Applications/Agent Cue.app/Contents/MacOS/AgentCue',
    'C:\\Apps\\Agent Cue\\AgentCue.exe',
  ])('preserves executable and argument boundaries for %s', (command) => {
    const args = ['--mcp-stdio'];
    const snippets = mcpSnippets({ command, args, commandReady: true });
    for (const id of ['gemini-cli', 'qwen-code']) {
      const server = JSON.parse(snippets.find((s) => s.id === id)!.json).mcpServers[
        'ai-workflow-monitor'
      ];
      expect(server).toEqual({ command, args });
    }
    const openCode = JSON.parse(snippets.find((s) => s.id === 'opencode')!.json);
    expect(openCode.mcp.servers['ai-workflow-monitor']).toEqual({
      type: 'local',
      command: [command, ...args],
    });
    const deepseek = snippets.find((s) => s.id === 'deepseek-harness')!;
    expect(deepseek.format).toBe('yaml');
    expect(parse(deepseek.json)[0]).toEqual({
      id: 'mcp-agentcue',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'agentcue', transport: 'stdio', command, args },
    });
  });
});
