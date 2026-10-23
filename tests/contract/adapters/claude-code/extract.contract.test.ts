/**
 * claude-code 适配器契约测试（T-M0-04 验收）。
 * 用 fixture 样本会话文件驱动提取器，比对期望事件序列（详细设计 7.4）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractEvents, loadManifestFromText, parseJsonl, type RawLine } from '@awm/adapters';

/** 仓库根目录 */
const root = process.cwd();

/** 内置 manifest 路径 */
const manifestPath = path.resolve(
  root,
  'packages/adapters/resources/adapters/claude-code.manifest.yaml',
);

/** fixture 目录 */
const fixtureDir = path.resolve(root, 'tests/contract/adapters/claude-code');

/** 加载内置 manifest */
function loadManifest() {
  return loadManifestFromText(readFileSync(manifestPath, 'utf8'), manifestPath);
}

/** 期望事件的最小比对结构 */
interface ExpectedEvent {
  eventType: string;
  occurredAt: string;
  actor: string;
  reason?: string;
}

describe('claude-code 提取器契约', () => {
  it('样本会话产出期望的事件序列', () => {
    const manifest = loadManifest();
    const text = readFileSync(path.join(fixtureDir, 'sample.jsonl'), 'utf8');
    const { rows, badLineNumbers } = parseJsonl(text);

    expect(badLineNumbers).toEqual([]);
    const events = extractEvents(rows, manifest, {
      toolId: manifest.id,
      project: 'demo-project',
      sessionKey: 'sess-1',
    });

    const expected = JSON.parse(
      readFileSync(path.join(fixtureDir, 'expected-events.json'), 'utf8'),
    ) as ExpectedEvent[];

    expect(events).toHaveLength(expected.length);
    expected.forEach((item, index) => {
      const actual = events[index];
      expect(actual?.eventType).toBe(item.eventType);
      expect(actual?.occurredAt).toBe(item.occurredAt);
      expect(actual?.actor).toBe(item.actor);
      if (item.reason) {
        expect(actual?.payload.reason).toBe(item.reason);
      }
    });
  });

  it('会话 id 按 {toolId}:{project}:{sessKey} 拼装', () => {
    const manifest = loadManifest();
    const events = extractEvents(
      [{ type: 'permission_request', timestamp: '2026-10-19T10:01:00.000Z' }],
      manifest,
      { toolId: manifest.id, project: 'p1', sessionKey: 'k1' },
    );
    expect(events[0]?.sessionId).toBe('claude-code:p1:k1');
  });

  it('is_error 为 true 的 result 映射为 task.failed', () => {
    const manifest = loadManifest();
    const rows: RawLine[] = [
      { type: 'result', timestamp: '2026-10-19T10:06:00.000Z', is_error: true },
    ];
    const events = extractEvents(rows, manifest, {
      toolId: manifest.id,
      project: 'p1',
      sessionKey: 'k1',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('task.failed');
  });

  it('无法匹配的行不产生事件', () => {
    const manifest = loadManifest();
    const { rows } = parseJsonl('{"type":"user","message":{"content":"hi"}}\n{bad json\n');
    expect(rows).toHaveLength(1);
    const events = extractEvents(rows, manifest, {
      toolId: manifest.id,
      project: 'p1',
      sessionKey: 'k1',
    });
    expect(events).toHaveLength(0);
  });
});
