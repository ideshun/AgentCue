/**
 * 适配器 manifest 契约测试。
 * 覆盖：合法样例、id 规范、必填项、心跳约束。
 */
import { describe, expect, it } from 'vitest';
import { adapterManifestSchema } from './manifest';

/** 合法 manifest 样例（结构对齐详细设计 5.4 的 claude-code 契约示例） */
const validManifest = {
  id: 'demo-tool',
  name: 'Demo Tool',
  detect: {
    configPaths: [
      {
        mac: '~/.demo/settings.json',
        win: '%USERPROFILE%/.demo/settings.json',
        envOverride: ['DEMO_CONFIG_DIR'],
      },
    ],
    processNames: ['demo'],
    apis: [],
  },
  sessionSource: {
    type: 'jsonl',
    pathPattern: '~/.demo/projects/**/*.jsonl',
  },
  eventMapping: {
    waiting_human: { match: 'permission_request', reason: 'tool_approval' },
    completed: { match: 'result', ok: true },
    failed: { match: 'result', ok: false },
  },
  heartbeat: { intervalSec: 30, probe: 'file_mtime' },
  mcp: { clientConfigFormat: 'demo-tool' },
};

describe('adapterManifestSchema', () => {
  it('接受合法 manifest', () => {
    const result = adapterManifestSchema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it('拒绝含大写字母的 id', () => {
    const result = adapterManifestSchema.safeParse({ ...validManifest, id: 'DemoTool' });
    expect(result.success).toBe(false);
  });

  it('拒绝非正数的心跳间隔', () => {
    const result = adapterManifestSchema.safeParse({
      ...validManifest,
      heartbeat: { intervalSec: 0, probe: 'file_mtime' },
    });
    expect(result.success).toBe(false);
  });

  it('拒绝未声明的会话来源类型', () => {
    const manifest = {
      ...validManifest,
      sessionSource: { ...validManifest.sessionSource, type: 'socket' },
    };
    const result = adapterManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('缺少 eventMapping 时拒绝', () => {
    const manifest: Record<string, unknown> = { ...validManifest };
    delete manifest.eventMapping;
    const result = adapterManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('detect 缺省字段自动填充默认值', () => {
    const parsed = adapterManifestSchema.parse({
      ...validManifest,
      detect: {},
    });
    expect(parsed.detect.configPaths).toEqual([]);
    expect(parsed.detect.processNames).toEqual([]);
    expect(parsed.detect.apis).toEqual([]);
  });
});
