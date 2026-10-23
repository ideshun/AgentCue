/**
 * 契约测试：内置适配器资源必须通过 manifest 校验（详细设计 5.4）。
 * 每个适配器至少 1 个 fixture 目录（样本会话文件 + 期望事件序列），见 7.4。
 *
 * 覆盖范围：全部 resources/adapters/*.yaml，新增 manifest 自动进入守护，
 * 避免出现「加了文件但没人校验」的死资源。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadManifestFromText, type AdapterManifest } from '@awm/adapters';
import { sessionSourceTypeSchema } from '@awm/schema';

/** 内置适配器资源目录 */
const ADAPTERS_DIR = path.resolve(process.cwd(), 'packages/adapters/resources/adapters');

/**
 * 读取并校验一个 manifest 文件。
 * @param fileName 文件名
 * @returns 校验通过的 manifest
 */
function loadManifestFile(fileName: string): AdapterManifest {
  const raw = readFileSync(path.join(ADAPTERS_DIR, fileName), 'utf8');
  return loadManifestFromText(raw, fileName);
}

/** 目录下全部 manifest 文件名 */
const MANIFEST_FILES = readdirSync(ADAPTERS_DIR).filter((name) => name.endsWith('.yaml'));

describe('内置适配器 manifest', () => {
  it('资源目录非空', () => {
    expect(MANIFEST_FILES.length).toBeGreaterThan(0);
  });

  it.each(MANIFEST_FILES)('%s 符合契约', (fileName) => {
    const manifest = loadManifestFile(fileName);
    expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(sessionSourceTypeSchema.safeParse(manifest.sessionSource.type).success).toBe(true);
    expect(manifest.heartbeat.intervalSec).toBeGreaterThan(0);
  });

  it('claude-code 的完整映射契约', () => {
    const manifest = loadManifestFile('claude-code.manifest.yaml');
    expect(manifest.id).toBe('claude-code');
    expect(manifest.detect.processNames).toContain('claude');
    expect(manifest.sessionSource.type).toBe('jsonl');
    expect(manifest.heartbeat).toEqual({ intervalSec: 30, probe: 'file_mtime' });
    // 三类语义键必须齐备，缺一类都会让某条真实会话漏事件
    expect(Object.keys(manifest.eventMapping).sort()).toEqual([
      'completed',
      'failed',
      'waiting_human',
    ]);
  });

  it('cursor 在无公开会话契约时必须保持空 eventMapping', () => {
    const manifest = loadManifestFile('cursor.manifest.yaml');
    expect(manifest.eventMapping).toBeDefined();
    expect(Object.keys(manifest.eventMapping)).toHaveLength(0);
  });

  it('codex 已按公开 rollout 补全事件映射，且不含 waiting_human', () => {
    const manifest = loadManifestFile('codex.manifest.yaml');
    expect(Object.keys(manifest.eventMapping).sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
      'started',
    ]);
    expect(manifest.eventMapping.waiting_human).toBeUndefined();
  });

  it('Cline 仅读历史索引，不向工作流伪造事件', () => {
    const manifest = loadManifestFile('cline.manifest.yaml');
    expect(manifest.sessionCapability).toBe('metadata');
    expect(manifest.sessionSource.type).toBe('json-index');
    expect(manifest.sessionSource.indexes?.map((source) => source.format)).toEqual([
      'cline-history-v1',
      'cline-sessions-v1',
    ]);
    expect(manifest.detect.extensions?.[0]?.id).toBe('saoudrizwan.claude-dev');
    expect(manifest.eventMapping).toEqual({});
  });

  it('CodeBuddy 仅检测扩展，未声明未经验证的会话路径', () => {
    const manifest = loadManifestFile('codebuddy.manifest.yaml');
    expect(manifest.sessionCapability).toBe('detect-only');
    expect(manifest.sessionSource.type).toBe('none');
    expect(manifest.sessionSource.pathPattern).toBeUndefined();
    expect(manifest.sessionSource.indexes).toBeUndefined();
    expect(manifest.detect.extensions?.[0]?.id.toLowerCase()).toBe('tencent-cloud.coding-copilot');
    expect(manifest.eventMapping).toEqual({});
  });
});
