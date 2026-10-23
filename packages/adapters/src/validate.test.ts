/**
 * 适配器校验器单测。
 */
import { describe, expect, it } from 'vitest';
import { validateManifestText } from './validate';
import { mcpSnippets } from './mcp-snippets';

const valid = `
id: demo-tool
name: Demo
detect:
  configPaths:
    - mac: "~/.demo"
  processNames: ["demo"]
sessionSource:
  type: jsonl
  pathPattern: "~/.demo/**/*.jsonl"
eventMapping: {}
heartbeat: { intervalSec: 30, probe: "file_mtime" }
`;

describe('validateManifestText', () => {
  it('接受合法 manifest', () => {
    const result = validateManifestText(valid, 'demo.yaml');
    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('demo-tool');
  });

  it('拒绝非法 YAML', () => {
    const result = validateManifestText('id: [', 'bad.yaml');
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('mcpSnippets', () => {
  it('覆盖客户端配置并区分 JSON 与 TOML', () => {
    const snippets = mcpSnippets();
    expect(snippets.map((item) => item.id).sort()).toEqual([
      'claude-code',
      'claude-desktop',
      'cline',
      'codebuddy',
      'codex',
      'cursor',
      'vscode',
    ]);
    for (const snippet of snippets) {
      if (snippet.format === 'json') expect(() => JSON.parse(snippet.json)).not.toThrow();
      else expect(snippet.json).toContain('[mcp_servers.ai-workflow-monitor]');
    }
  });
});
