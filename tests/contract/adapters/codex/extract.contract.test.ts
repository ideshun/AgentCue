/**
 * Codex CLI 适配器契约测试。
 * fixture 按公开 rollout 信封合成，不含真实用户会话内容。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractEvents,
  extractSourceBatch,
  loadManifestFromText,
  parseJsonl,
  type RawLine,
  type SourceTaskContext,
} from '@awm/adapters';

/** 仓库根目录 */
const root = process.cwd();

/** 内置 manifest 路径 */
const manifestPath = path.resolve(root, 'packages/adapters/resources/adapters/codex.manifest.yaml');

/** fixture 目录 */
const fixtureDir = path.resolve(root, 'tests/contract/adapters/codex');
const manifest = loadManifestFromText(readFileSync(manifestPath, 'utf8'), manifestPath);
const context = { toolId: manifest.id, project: 'demo-project', sessionKey: 'sess-1' };
const base = 'codex:demo-project:sess-1';

function event(type: string, turnId?: string): RawLine {
  return {
    timestamp: '2026-10-20T11:00:00.000Z',
    type: 'event_msg',
    payload: { type, ...(turnId ? { turn_id: turnId } : {}) },
  };
}

function user(message: string): RawLine {
  return { type: 'event_msg', payload: { type: 'user_message', message } };
}

/** 期望事件的最小比对结构 */
interface ExpectedEvent {
  eventType: string;
  occurredAt: string;
  actor: string;
}

describe('codex 提取器契约', () => {
  it('合成 rollout 产出 started / completed / failed / cancelled', () => {
    const manifest = loadManifestFromText(readFileSync(manifestPath, 'utf8'), manifestPath);
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
    });
    expect(events[0]?.sessionId).toBe(`${base}:turn:t1`);
    expect(events[1]?.payload.taskTitle).toBe('重构演示模块');
    expect(events[2]?.sessionId).toBe(`${base}:turn:t2`);
    expect(events[3]?.payload.taskTitle).toBe('补充失败处理');
    expect(events[4]?.payload.taskTitle).toBeUndefined();
  });

  it('审批类瞬时事件不在 JSONL 中，waiting_human 无映射', () => {
    const manifest = loadManifestFromText(readFileSync(manifestPath, 'utf8'), manifestPath);
    expect(manifest.eventMapping.waiting_human).toBeUndefined();
  });

  it('同批 start 在用户消息前时回填用户标题，两轮使用独立任务标识', () => {
    const result = extractSourceBatch(
      [
        event('task_started', 'one'), user('第一轮真实请求'), event('task_complete', 'one'),
        event('task_started', 'two'), user('第二轮真实请求'), event('task_complete', 'two'),
      ],
      manifest,
      context,
    );
    expect(result.events.map((item) => [item.sessionId, item.payload.taskTitle])).toEqual([
      [`${base}:turn:one`, '第一轮真实请求'], [`${base}:turn:one`, '第一轮真实请求'],
      [`${base}:turn:two`, '第二轮真实请求'], [`${base}:turn:two`, '第二轮真实请求'],
    ]);
    expect(result.context).toEqual({ taskId: 'two', title: '第二轮真实请求', closed: true });
    expect(result.titles).toEqual([
      { sessionId: `${base}:turn:one`, title: '第一轮真实请求' },
      { sessionId: `${base}:turn:two`, title: '第二轮真实请求' },
    ]);
  });

  it('start-only 批次后，用户消息可跨批次补全同一任务标题', () => {
    const first = extractSourceBatch([event('task_started', 'one')], manifest, context);
    expect(first.events[0]?.payload.taskTitle).toBeUndefined();
    expect(first.titles).toEqual([{ sessionId: `${base}:turn:one`, title: null }]);
    const second = extractSourceBatch([user('跨批用户标题')], manifest, { ...context, context: first.context });
    expect(second.events).toEqual([]);
    expect(second.titles).toEqual([{ sessionId: `${base}:turn:one`, title: '跨批用户标题' }]);
    const third = extractSourceBatch([event('task_complete', 'one')], manifest, { ...context, context: second.context });
    expect(third.events[0]?.payload.taskTitle).toBe('跨批用户标题');
    expect(first.context).toEqual({ taskId: 'one', title: null, closed: false });
  });

  it('已完成任务后的用户消息先暂存，新轮开始时消费 pendingTitle', () => {
    const prior: SourceTaskContext = { taskId: 'one', title: '上一轮', closed: true };
    const pending = extractSourceBatch([user('下一轮请求')], manifest, { ...context, context: prior });
    expect(prior).toEqual({ taskId: 'one', title: '上一轮', closed: true });
    expect(pending.context).toEqual({ ...prior, pendingTitle: '下一轮请求' });
    expect(pending.titles).toEqual([]);
    const next = extractSourceBatch([event('task_started', 'two')], manifest, { ...context, context: pending.context });
    expect(next.events[0]?.payload.taskTitle).toBe('下一轮请求');
    expect(next.context).toEqual({ taskId: 'two', title: '下一轮请求', closed: false });
  });

  it('第一条用户消息在首个 start 前时，同样关联到下一轮', () => {
    const pending = extractSourceBatch([user('第一轮请求')], manifest, context);
    const next = extractSourceBatch([event('task_started', 'one')], manifest, { ...context, context: pending.context });
    expect(next.events[0]?.sessionId).toBe(`${base}:turn:one`);
    expect(next.events[0]?.payload.taskTitle).toBe('第一轮请求');
  });

  it('新轮没有用户消息时不会复用文件标题或上一轮标题', () => {
    const result = extractSourceBatch([event('task_started', 'two')], manifest, {
      ...context,
      title: '文件级最初标题',
      context: { taskId: 'one', title: '上一轮标题', closed: true },
    });
    expect(result.events[0]?.payload.taskTitle).toBeUndefined();
    expect(result.titles).toEqual([{ sessionId: `${base}:turn:two`, title: null }]);
    expect(result.context).toEqual({ taskId: 'two', title: null, closed: false });
  });

  it('没有 turn_id 的旧行仍使用文件级标识，不从当前上下文编造 turn', () => {
    const result = extractSourceBatch([event('task_started'), event('task_complete')], manifest, {
      ...context,
      title: '旧版真实用户标题',
      context: { taskId: 'known', title: '当前轮标题' },
    });
    expect(result.events.map((item) => item.sessionId)).toEqual([base, base]);
    expect(result.events.map((item) => item.payload.taskTitle)).toEqual(['旧版真实用户标题', '旧版真实用户标题']);
  });

  it('接受官方 turn_started / turn_complete 别名', () => {
    const result = extractSourceBatch([event('turn_started', 'one'), user('别名任务'), event('turn_complete', 'one')], manifest, context);
    expect(result.events.map((item) => item.eventType)).toEqual(['task.started', 'task.completed']);
    expect(result.events.every((item) => item.sessionId === `${base}:turn:one`)).toBe(true);
    expect(result.events.every((item) => item.payload.taskTitle === '别名任务')).toBe(true);
  });

  it('旧文件级任务结束后不会向新增 turn 复用旧的暂存标题', () => {
    const legacy = extractSourceBatch([user('旧版请求'), event('task_started'), event('task_complete')], manifest, context);
    expect(legacy.context).toEqual({ title: '旧版请求', closed: true });
    const next = extractSourceBatch([event('task_started', 'new')], manifest, { ...context, context: legacy.context });
    expect(next.events[0]?.payload.taskTitle).toBeUndefined();
    const pending = extractSourceBatch([user('升级后的新请求')], manifest, { ...context, context: legacy.context });
    const titled = extractSourceBatch([event('task_started', 'new')], manifest, { ...context, context: pending.context });
    expect(titled.events[0]?.payload.taskTitle).toBe('升级后的新请求');
  });

  it('完成输出与审批输出不覆盖当前用户标题', () => {
    const rows: RawLine[] = [
      event('task_started', 'one'),
      user('真实用户请求'),
      { type: 'permission_request', message: { content: '{"risk_level":"low"}' } },
      { ...event('task_complete', 'one'), payload: { type: 'task_complete', turn_id: 'one', last_agent_message: '{"risk_level":"low"}' } },
    ];
    const result = extractSourceBatch(rows, manifest, context);
    expect(result.events.every((item) => item.payload.taskTitle === '真实用户请求')).toBe(true);
  });

  it('不同切分位置仍使用稳定事件ID，并保留最终轮上下文和标题', () => {
    const rows = [
      event('task_started', 'one'), user('第一轮'), event('task_complete', 'one'),
      user('第二轮先到的请求'), event('task_started', 'two'), event('task_complete', 'two'),
    ];
    const full = extractSourceBatch(rows, manifest, context);
    for (let split = 1; split < rows.length; split += 1) {
      const first = extractSourceBatch(rows.slice(0, split), manifest, context);
      const second = extractSourceBatch(rows.slice(split), manifest, { ...context, context: first.context });
      expect([...first.events, ...second.events].map((item) => item.eventId)).toEqual(full.events.map((item) => item.eventId));
      expect(second.context).toEqual(full.context);
      const titles = new Map([...first.titles, ...second.titles].filter((item) => item.title).map((item) => [item.sessionId, item.title]));
      expect(titles.get(`${base}:turn:one`)).toBe('第一轮');
      expect(titles.get(`${base}:turn:two`)).toBe('第二轮先到的请求');
    }
  });

  it.each([
    { internal: 'guardian' },
    { internal: 'memory_consolidation' },
    { internal: 'future_unknown_source' },
    { subagent: 'review' },
    { subagent: 'compact' },
    { subagent: 'memory_consolidation' },
    { subagent: { other: 'future_unknown_source' } },
    { subagent: { thread_spawn: { parent_thread_id: 'synthetic-parent', depth: 1 } } },
  ])('排除内部来源与子 Agent %j，不产生事件或任务标题', (source) => {
    const result = extractSourceBatch([
      { type: 'session_meta', payload: { source } },
      event('task_started', 'internal-one'),
      user('{"risk_level":"low"}'),
      event('task_complete', 'internal-one'),
    ], manifest, context);
    expect(result).toEqual({ events: [], titles: [], context: { excluded: true } });
  });

  it('内部来源标志跨批持久保留，后续没有元数据也不产生用户任务', () => {
    const first = extractSourceBatch([{ type: 'session_meta', payload: { source: { internal: 'guardian' } } }], manifest, context);
    const second = extractSourceBatch([event('task_started', 'one'), user('审批内部提示')], manifest, { ...context, context: first.context });
    const third = extractSourceBatch([event('task_complete', 'one'), event('task_started', 'two')], manifest, { ...context, context: second.context });
    expect(second).toEqual({ events: [], titles: [], context: { excluded: true } });
    expect(third).toEqual(second);
  });

  it.each([false, true])('排除来源会清除历史 context 中的内部标题和任务信息（已标记=%s）', (alreadyExcluded) => {
    const prior: SourceTaskContext = {
      taskId: 'internal-one', title: '内部审批提示', pendingTitle: '内部后续提示', closed: true,
      ...(alreadyExcluded ? { excluded: true } : {}),
    };
    const rows = [
      ...(alreadyExcluded ? [] : [{ type: 'session_meta', payload: { source: { internal: 'guardian' } } }]),
      event('task_started', 'internal-two'), user('不应保存的标题'),
    ];
    const result = extractSourceBatch(rows, manifest, { ...context, context: prior });
    expect(result).toEqual({ events: [], titles: [], context: { excluded: true } });
    expect(prior.title).toBe('内部审批提示');
  });

  it.each([
    'cli', 'vscode', 'exec', 'mcp', 'unknown', undefined,
    { custom: 'synthetic-extension' },
  ])('保留普通来源 %j，用户 risk_level JSON 可以作为真实请求', (source) => {
    const text = '{"risk_level":"low"}';
    const result = extractSourceBatch([
      { type: 'session_meta', payload: { source } },
      event('task_started', 'one'), user(text), event('task_complete', 'one'),
    ], manifest, context);
    expect(result.context).toMatchObject({ excluded: false, taskId: 'one', title: text, closed: true });
    expect(result.events).toHaveLength(2);
    expect(result.events.every((item) => item.payload.taskTitle === text)).toBe(true);
    expect(result.titles).toEqual([{ sessionId: `${base}:turn:one`, title: text }]);
  });

  it.each([
    'internal_guardian', 'internal_memory_consolidation', 'subagent_review',
    '{"internal":"guardian"}',
    { internal: { guardian: {} } },
    { subagent: { review: {} } },
    { internal: 'guardian', custom: 'ambiguous' },
  ])('不猜测 Display 字符串或不符合 serializer 的来源 %j', (source) => {
    const result = extractSourceBatch([
      { type: 'session_meta', payload: { source } },
      event('task_started', 'one'), user('正常请求'),
    ], manifest, context);
    expect(result.events).toHaveLength(1);
    expect(result.context.excluded).toBe(false);
  });

  it('正文包含内部来源形状也不改变 session_meta 的分类', () => {
    const title = '{"source":{"internal":"guardian"}}';
    const result = extractSourceBatch([
      { type: 'session_meta', payload: { source: 'cli' } },
      event('task_started', 'one'), user(title),
    ], manifest, context);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.payload.taskTitle).toBe(title);
    expect(result.context.excluded).toBe(false);
  });

  it('只按首条 session_meta 分类，后续同批或跨批元数据不重写来源', () => {
    const first = extractSourceBatch([
      { type: 'session_meta', payload: { source: 'cli' } },
      { type: 'session_meta', payload: { source: { internal: 'guardian' } } },
      event('task_started', 'one'), user('第一轮'), event('task_complete', 'one'),
    ], manifest, context);
    expect(first.events).toHaveLength(2);
    expect(first.context.excluded).toBe(false);
    const second = extractSourceBatch([
      { type: 'session_meta', payload: { source: { subagent: 'review' } } },
      event('task_started', 'two'), user('第二轮'),
    ], manifest, { ...context, context: first.context });
    expect(second.events).toHaveLength(1);
    expect(second.context).toMatchObject({ excluded: false, taskId: 'two', title: '第二轮' });
  });
});
