/** Cline 4.1.25 公开索引形状的合成样本，不包含真实会话。 */
import { describe, expect, it } from 'vitest';
import { adapterManifestSchema, TASK_STATES } from '@awm/schema';
import { parseMetadataIndex, sessionCapability } from './metadata';

const timestamp = Date.UTC(2026, 9, 20, 12, 0);

describe('历史索引最小元数据', () => {
  it('legacy 数组仅读取 id/ts/task，保留未知工作流状态', () => {
    const source = [{ id: 'legacy-one', ts: timestamp, task: '  修复\n 设置   布局  ' }];
    expect(parseMetadataIndex(source, 'cline-history-v1', 'cline')).toEqual([
      {
        kind: 'history',
        sessionId: 'cline:history:legacy-one',
        toolId: 'cline',
        title: '修复 设置 布局',
        currentState: null,
        updatedAt: new Date(timestamp).toISOString(),
      },
    ]);
    expect(source[0]).toEqual({ id: 'legacy-one', ts: timestamp, task: '  修复\n 设置   布局  ' });
  });

  it('sessions.index 只提取白名单字段，不读取正文、凭据或被索引文件', () => {
    const session = {
      sessionId: 'sdk-one',
      prompt: '改进检测',
      updatedAt: timestamp,
      startedAt: timestamp - 5000,
      status: 'completed',
      tokensIn: 123,
    };
    for (const key of ['messagesPath', 'historyPath', 'apiKey', 'messages', 'rawConversation']) {
      Object.defineProperty(session, key, {
        enumerable: true,
        get() {
          throw new Error('禁止读取 ' + key);
        },
      });
    }
    const source = {
      version: 1,
      sessions: { 'sdk-one': session },
      databasePath: '/never/open/sessions.db',
    };
    const result = parseMetadataIndex(source, 'cline-sessions-v1', 'cline');
    expect(result).toEqual([
      {
        kind: 'history',
        sessionId: 'cline:history:sdk-one',
        toolId: 'cline',
        title: '改进检测',
        currentState: null,
        updatedAt: new Date(timestamp).toISOString(),
        sourceStatus: 'completed',
      },
    ]);
    expect(Object.keys(result[0]).sort()).toEqual([
      'currentState',
      'kind',
      'sessionId',
      'sourceStatus',
      'title',
      'toolId',
      'updatedAt',
    ]);
    expect(session.status).toBe('completed');
    expect([...TASK_STATES]).not.toContain('unknown');
  });

  it('明确来源状态不被伪装成 AWM 状态', () => {
    const values = ['running', 'completed', 'arbitrary-upstream-state'].map((status, index) => ({
      sessionId: 'sdk-' + index,
      prompt: '任务',
      startedAt: new Date(timestamp).toISOString(),
      status,
    }));
    const result = parseMetadataIndex(
      { version: 1, sessions: Object.fromEntries(values.map((value) => [value.sessionId, value])) },
      'cline-sessions-v1',
      'cline',
    );
    expect(result).toHaveLength(3);
    expect(result.every((item) => item.kind === 'history' && item.currentState === null)).toBe(
      true,
    );
    expect(result.map((item) => item.sourceStatus)).toEqual(values.map((value) => value.status));
  });

  it('缺少标题使用占位，合法空索引保持为空', () => {
    expect(
      parseMetadataIndex([{ id: 'untitled', ts: 0 }], 'cline-history-v1', 'cline')[0]?.title,
    ).toBe('未命名历史任务');
    expect(parseMetadataIndex([], 'cline-history-v1', 'cline')).toEqual([]);
    expect(parseMetadataIndex({ version: 1, sessions: {} }, 'cline-sessions-v1', 'cline')).toEqual(
      [],
    );
  });

  it('跳过无效记录并限制标题/状态长度', () => {
    const entries = [
      null,
      [],
      'bad',
      { id: '', ts: timestamp },
      { id: 'a'.repeat(501), ts: timestamp },
      { id: 'invalid-date', ts: 'not-a-date' },
      { id: 'missing-time', task: '任务' },
      { id: 'ok', ts: timestamp, task: '字'.repeat(500), status: 's'.repeat(100) },
    ];
    const result = parseMetadataIndex(entries, 'cline-history-v1', 'cline');
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toHaveLength(120);
    expect(result[0]?.sourceStatus).toHaveLength(60);
  });

  it.each([
    [{ tasks: [] }, 'cline-history-v1'],
    [{ version: 2, sessions: {} }, 'cline-sessions-v1'],
    [{ version: 1, sessions: [] }, 'cline-sessions-v1'],
    [{ version: 1 }, 'cline-sessions-v1'],
    [{ version: 1, sessions: null }, 'cline-sessions-v1'],
    [[], 'unverified-new-format'],
  ])('未知顶层格式明确拒绝：%s / %s', (value, format) => {
    expect(() => parseMetadataIndex(value, String(format), 'cline')).toThrow('不支持');
  });
});

describe('适配器能力兼容', () => {
  const manifest = adapterManifestSchema.parse({
    id: 'demo',
    name: 'Demo',
    detect: {},
    sessionSource: { type: 'none' },
    eventMapping: {},
    heartbeat: { intervalSec: 30, probe: 'file_mtime' },
  });
  it('旧空映射默认仅检测，有映射默认事件，显式能力优先', () => {
    expect(sessionCapability(manifest)).toBe('detect-only');
    expect(
      sessionCapability({ ...manifest, eventMapping: { completed: { match: 'result' } } }),
    ).toBe('events');
    expect(sessionCapability({ ...manifest, sessionCapability: 'metadata' })).toBe('metadata');
  });
});
