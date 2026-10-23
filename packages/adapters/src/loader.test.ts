/**
 * 适配器加载与注册单测。
 * 覆盖：合法 manifest、字段级错误提示、YAML 语法错误、重复注册保护。
 */
import { describe, expect, it } from 'vitest';
import { loadManifestFromText, ManifestLoadError } from './loader';
import { AdapterRegistry } from './registry';

/** 合法 manifest 文本 */
const VALID_YAML = `
id: claude-code
name: Claude Code
detect:
  configPaths:
    - mac: "~/.claude/settings.json"
      win: "%USERPROFILE%/.claude/settings.json"
      envOverride: ["CLAUDE_CONFIG_DIR"]
  processNames: ["claude"]
  apis: []
sessionSource:
  type: jsonl
  pathPattern: "~/.claude/projects/**/*.jsonl"
eventMapping:
  waiting_human: { match: "permission_request", reason: "tool_approval" }
  completed: { match: "result", ok: true }
  failed: { match: "result", ok: false }
heartbeat: { intervalSec: 30, probe: "file_mtime" }
mcp: { clientConfigFormat: "claude-code" }
`;

describe('loadManifestFromText', () => {
  it('接受合法 manifest', () => {
    const manifest = loadManifestFromText(VALID_YAML, 'claude-code.manifest.yaml');
    expect(manifest.id).toBe('claude-code');
    expect(manifest.heartbeat.intervalSec).toBe(30);
    expect(manifest.eventMapping.waiting_human?.match).toBe('permission_request');
  });

  it('字段非法时指明字段路径', () => {
    const invalid = VALID_YAML.replace('id: claude-code', 'id: ClaudeCode');
    try {
      loadManifestFromText(invalid, 'bad.manifest.yaml');
      expect.unreachable('应抛出 ManifestLoadError');
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestLoadError);
      const loadError = error as ManifestLoadError;
      expect(loadError.fields).toContain('id');
      expect(loadError.message).toContain('bad.manifest.yaml');
    }
  });

  it('YAML 语法错误时给出文件路径', () => {
    try {
      loadManifestFromText('id: [unclosed', 'broken.manifest.yaml');
      expect.unreachable('应抛出 ManifestLoadError');
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestLoadError);
      expect((error as ManifestLoadError).message).toContain('broken.manifest.yaml');
    }
  });
});

describe('AdapterRegistry', () => {
  it('注册后可查询与列举', () => {
    const registry = new AdapterRegistry();
    registry.register(loadManifestFromText(VALID_YAML, 'claude-code.manifest.yaml'));
    expect(registry.size).toBe(1);
    expect(registry.has('claude-code')).toBe(true);
    expect(registry.get('claude-code')?.name).toBe('Claude Code');
  });

  it('重复 id 注册被拒绝', () => {
    const registry = new AdapterRegistry();
    const manifest = loadManifestFromText(VALID_YAML, 'claude-code.manifest.yaml');
    registry.register(manifest);
    expect(() => registry.register(manifest)).toThrow(/id 重复/);
  });

  it('注销后不再可查询', () => {
    const registry = new AdapterRegistry();
    registry.register(loadManifestFromText(VALID_YAML, 'claude-code.manifest.yaml'));
    expect(registry.unregister('claude-code')).toBe(true);
    expect(registry.size).toBe(0);
  });
});
