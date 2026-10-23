import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { desktopMcpLaunch } from '../../apps/desktop/src/main/mcp-launch';
import { runStdio } from '../../apps/mcp-stdio/src/stdio';
import { mcpSnippets } from '@awm/adapters';

describe('bundled MCP launch', () => {
  it('builds absolute development and packaged launch commands without global PATH', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'awm-mcp-launch-'));
    try {
      mkdirSync(path.join(root, 'dist/resources/mcp-stdio'), { recursive: true });
      writeFileSync(path.join(root, 'dist/resources/mcp-stdio/stdio.js'), '');
      const development = desktopMcpLaunch({
        executablePath: process.execPath,
        appPath: root,
        isPackaged: false,
      });
      expect(development).toEqual({
        command: process.execPath,
        args: [root, '--mcp-stdio'],
        commandReady: true,
      });
      expect(
        desktopMcpLaunch({ executablePath: process.execPath, appPath: root, isPackaged: true })
          .args,
      ).toEqual(['--mcp-stdio']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shared stdio entry enumerates tools without runtime credentials or SQLite', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    const done = runStdio(input, output, new PassThrough());
    input.end(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    );
    await done;
    const responses = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { result: { tools?: unknown[] } });
    expect(responses).toHaveLength(2);
    expect(responses[1]?.result.tools).toHaveLength(6);
  });

  it('includes Cline and CodeBuddy instructions, actual args, and valid TOML for Codex', () => {
    const snippets = mcpSnippets({
      command: '/Applications/AWM.app/Contents/MacOS/AWM',
      args: ['--mcp-stdio'],
      commandReady: true,
    });
    for (const id of ['cursor', 'cline', 'codebuddy']) {
      const snippet = snippets.find((item) => item.id === id)!;
      expect(snippet.steps.length).toBeGreaterThan(2);
      expect(JSON.parse(snippet.json).mcpServers['ai-workflow-monitor'].args).toEqual([
        '--mcp-stdio',
      ]);
    }
    const codex = snippets.find((item) => item.id === 'codex')!;
    expect(codex.format).toBe('toml');
    expect(codex.json).toContain('[mcp_servers.ai-workflow-monitor]');
    expect(codex.json).toContain('args = ["--mcp-stdio"]');
  });
});
