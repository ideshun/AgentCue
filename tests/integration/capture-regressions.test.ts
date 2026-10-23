/** Synthetic file sources only: no installed-tool storage or private histories are read. */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type AdapterManifest, type Settings } from '@awm/schema';
import { createStandardEvent, type ScanReport } from '@awm/core';
import {
  createDatabase,
  countActiveByTool,
  countSessions,
  getSession,
  getSourceCheckpoint,
  listEvents,
  listSessions,
  saveSourceCheckpoint,
  updateSessionTitle,
} from '@awm/store';
import { Engine } from '../../apps/desktop/src/main/engine-host';
import { MonitorService } from '../../apps/desktop/src/main/monitor-service';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

interface Harness {
  root: string;
  dataDir: string;
  adaptersDir: string;
  source: string;
  index: string;
  settings: Settings;
  engine: Engine;
  monitor: MonitorService;
}
const harnesses: Harness[] = [];
const SESSION_ID = 'fixture-agent:project-a:task-a';
const CODEX_SESSION_ID = 'codex:project-a:task-a';
const POLLUTED_TITLE = '{"risk_level":"low","user_authorization"';

function row(type: string, timestamp: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), ...extra });
}

function initialRows(at = Date.now() - 1000): string {
  return `${row('user', at, { message: { role: 'user', content: '本地合成任务' } })}\n${row('started', at + 1)}\n`;
}

function makeHarness(
  content: string,
  capability: 'events' | 'metadata' | 'detect-only' = 'events',
): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'awm-capture-regression-'));
  const dataDir = path.join(root, 'app-data');
  const adaptersDir = path.join(root, 'adapters');
  const source = path.join(root, 'sources/project-a/task-a.jsonl');
  const index = path.join(root, 'history-index.json');
  mkdirSync(adaptersDir, { recursive: true });
  mkdirSync(path.dirname(source), { recursive: true });
  const config = path.join(root, 'installation-marker.json');
  writeFileSync(config, '{}');
  writeFileSync(source, content);
  const platformPaths = (value: string) => ({ mac: value, win: value, linux: value });
  const manifest: AdapterManifest = {
    id: 'fixture-agent',
    name: 'Synthetic fixture',
    sessionCapability: capability,
    detect: { configPaths: [platformPaths(config)], processNames: [], apis: [] },
    sessionSource:
      capability === 'metadata'
        ? {
            type: 'json-index',
            indexes: [{ format: 'cline-history-v1', paths: [platformPaths(index)] }],
          }
        : { type: capability === 'detect-only' ? 'dir-watch' : 'jsonl', pathPattern: source },
    eventMapping:
      capability === 'events'
        ? {
            started: { match: 'started' },
            waiting_human: { match: 'permission_request' },
            completed: { match: 'result', ok: true },
            failed: { match: 'result', ok: false },
          }
        : {},
    heartbeat: { intervalSec: 1, probe: 'file_mtime' },
  };
  writeFileSync(path.join(adaptersDir, 'fixture.manifest.yaml'), JSON.stringify(manifest));
  const settings = defaultSettings();
  const engine = new Engine(dataDir);
  const monitor = new MonitorService({
    db: engine.database,
    engine,
    getSettings: () => settings,
    resourcesDir: adaptersDir,
  });
  const fixture = { root, dataDir, adaptersDir, source, index, settings, engine, monitor };
  harnesses.push(fixture);
  return fixture;
}

function rebuildMonitor(fixture: Harness, onCaptureComplete = vi.fn()): ReturnType<typeof vi.fn> {
  fixture.monitor.stop();
  fixture.monitor = new MonitorService({
    db: fixture.engine.database,
    engine: fixture.engine,
    getSettings: () => fixture.settings,
    resourcesDir: fixture.adaptersDir,
    onCaptureComplete,
  });
  return onCaptureComplete;
}

function useCodexManifest(fixture: Harness): void {
  const file = path.join(fixture.adaptersDir, 'fixture.manifest.yaml');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as AdapterManifest;
  manifest.id = 'codex';
  manifest.eventMapping = {
    started: { match: 'task_started' },
    completed: { match: 'task_complete', ok: true },
    failed: { match: 'task_complete', ok: false },
    cancelled: { match: 'turn_aborted' },
  };
  writeFileSync(file, JSON.stringify(manifest));
  rebuildMonitor(fixture);
}

function codexEvent(type: string, at: number, extra: Record<string, unknown> = {}): string {
  return row('event_msg', at, { payload: { type, ...extra } }) + '\n';
}

function poisonTitle(fixture: Harness, sessionId = CODEX_SESSION_ID): void {
  expect(updateSessionTitle(fixture.engine.database, sessionId, POLLUTED_TITLE)).toBe(true);
  const checkpoint = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
  saveSourceCheckpoint(fixture.engine.database, { ...checkpoint, title: POLLUTED_TITLE });
}

async function tick(monitor: MonitorService): Promise<void> {
  await (monitor as unknown as { tick: () => Promise<void> }).tick();
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const fixture of harnesses.splice(0)) {
    fixture.monitor.stop();
    await fixture.engine.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe('incremental capture regressions', () => {
  it.each([false, true])(
    'excludes explicitly internal sources without events or speech (large metadata=%s)',
    async (large) => {
      const at = Date.now() - 5000;
      const fixture = makeHarness(
        row('session_meta', at, {
          payload: {
            source: { internal: 'guardian' },
            ...(large ? { padding: 'x'.repeat(600 * 1024) } : {}),
          },
        }) +
          '\n' +
          codexEvent('task_started', at + 1, { turn_id: 'internal-1' }) +
          codexEvent('user_message', at + 2, { message: '内部控制上下文' }) +
          codexEvent('task_complete', at + 3, { turn_id: 'internal-1' }),
      );
      useCodexManifest(fixture);
      const onTransition = vi.fn();
      fixture.engine.onTransition = onTransition;
      await fixture.monitor.scan();
      expect(listSessions(fixture.engine.database)).toEqual([]);
      expect(listEvents(fixture.engine.database)).toEqual([]);
      const checkpoint = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
      expect(checkpoint.context).toEqual({ excluded: true });
      expect(checkpoint.title).toBeNull();
      expect(checkpoint.offset).toBe(Buffer.byteLength(readFileSync(fixture.source)));
      rebuildMonitor(fixture);
      appendFileSync(fixture.source, codexEvent('task_started', at + 4, { turn_id: 'internal-2' }));
      await fixture.monitor.capture();
      await tick(fixture.monitor);
      expect(listSessions(fixture.engine.database)).toEqual([]);
      expect(listEvents(fixture.engine.database)).toEqual([]);
      expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.context).toEqual({
        excluded: true,
      });
      expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.title).toBeNull();
      expect(onTransition).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'hides legacy internal rows at EOF without replay or metadata changes (already marked=%s)',
    async (alreadyMarked) => {
      const at = Date.now() - 5000;
      const fixture = makeHarness(
        row('session_meta', at, { payload: { source: { subagent: 'compact' } } }) +
          '\n' +
          codexEvent('task_started', at + 1, { turn_id: 'internal-1' }) +
          codexEvent('user_message', at + 2, { message: '旧内部上下文' }),
      );
      useCodexManifest(fixture);
      await fixture.monitor.scan();
      const ids = [CODEX_SESSION_ID, CODEX_SESSION_ID + ':turn:internal-1'];
      for (const sessionId of ids) {
        fixture.engine.applyEvent(
          createStandardEvent({
            sessionId,
            toolId: 'codex',
            eventType: 'task.started',
            occurredAt: new Date(at + 1).toISOString(),
            payload: { taskTitle: POLLUTED_TITLE },
          }),
        );
      }
      expect(countActiveByTool(fixture.engine.database).get('codex')).toBe(2);
      const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
      saveSourceCheckpoint(fixture.engine.database, {
        ...previous,
        title: alreadyMarked ? null : POLLUTED_TITLE,
        context: {
          taskId: 'internal-1',
          title: POLLUTED_TITLE,
          ...(alreadyMarked ? { excluded: true } : {}),
        },
      });
      const before = ids.map((id) => getSession(fixture.engine.database, id)!);
      const events = listEvents(fixture.engine.database);
      const onCapture = rebuildMonitor(fixture);
      const onTransition = vi.fn();
      fixture.engine.onTransition = onTransition;
      expect(await fixture.monitor.capture()).toBe(0);
      await tick(fixture.monitor);
      await fixture.engine.stop();
      expect(listSessions(fixture.engine.database)).toEqual([]);
      expect(countSessions(fixture.engine.database)).toBe(0);
      expect(countActiveByTool(fixture.engine.database).get('codex')).toBeUndefined();
      for (const task of before)
        expect(getSession(fixture.engine.database, task.sessionId)).toEqual({
          ...task,
          visible: 0,
        });
      expect(listEvents(fixture.engine.database)).toEqual(events);
      expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toEqual({
        ...previous,
        title: null,
        context: { excluded: true },
      });
      expect(onTransition).not.toHaveBeenCalled();
      expect(onCapture).toHaveBeenCalledTimes(1);
      fixture.engine.applyEvent(
        createStandardEvent({
          sessionId: ids[1]!,
          toolId: 'codex',
          eventType: 'heartbeat.lost',
        }),
      );
      expect(listEvents(fixture.engine.database)).toEqual(events);
      expect(onTransition).not.toHaveBeenCalled();
    },
  );

  it('keeps real user JSON titles for ordinary sources (cli)', async () => {
    const at = Date.now() - 5000;
    const userTitle = '{"risk_level":"low"}';
    const fixture = makeHarness(
      row('session_meta', at, { payload: { source: 'cli' } }) +
        '\n' +
        codexEvent('task_started', at + 1, { turn_id: 't1' }) +
        codexEvent('user_message', at + 2, { message: userTitle }),
    );
    useCodexManifest(fixture);
    await fixture.monitor.scan();
    expect(listSessions(fixture.engine.database)).toMatchObject([
      { sessionId: CODEX_SESSION_ID + ':turn:t1', title: userTitle, visible: 1 },
    ]);
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.context).toMatchObject({
      excluded: false,
      taskId: 't1',
      title: userTitle,
    });
  });

  it('多 Agent 分配产生的 thread_spawn 子会话不进入任务列表或播报', async () => {
    const at = Date.now() - 5000;
    const fixture = makeHarness(
      row('session_meta', at, {
        payload: { source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } },
      }) +
        '\n' +
        codexEvent('task_started', at + 1, { turn_id: 't1' }) +
        codexEvent('task_complete', at + 2, { turn_id: 't1' }),
    );
    useCodexManifest(fixture);
    await fixture.monitor.scan();
    expect(listSessions(fixture.engine.database)).toEqual([]);
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.context).toEqual({
      excluded: true,
    });
  });

  it('keeps heartbeat observations independent when capture consumes non-state appends before tick', async () => {
    const at = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    const fixture = makeHarness(initialRows(at - 1000));
    const file = path.join(fixture.adaptersDir, 'fixture.manifest.yaml');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as AdapterManifest;
    manifest.heartbeat.intervalSec = 30;
    writeFileSync(file, JSON.stringify(manifest));
    rebuildMonitor(fixture);
    await fixture.monitor.scan();
    const initial = getSession(fixture.engine.database, SESSION_ID)!;
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      vi.setSystemTime(at + cycle * 30_000);
      appendFileSync(
        fixture.source,
        row('token_count', Date.now(), { total_tokens: cycle * 100 }) + '\n',
      );
      utimesSync(fixture.source, new Date(), new Date());
      expect(await fixture.monitor.capture()).toBe(0);
      await tick(fixture.monitor);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getSession(fixture.engine.database, SESSION_ID)).toEqual(initial);
    }
    expect(listEvents(fixture.engine.database)).toHaveLength(1);
    expect(listEvents(fixture.engine.database, { eventType: 'heartbeat.lost' })).toHaveLength(0);
    expect(listEvents(fixture.engine.database, { eventType: 'task.timeout' })).toHaveLength(0);
    expect(onTransition).not.toHaveBeenCalled();
  });

  it('repairs a legacy polluted title at EOF without events, state changes or announcement', async () => {
    const at = Date.now() - 5000;
    const fixture = makeHarness(
      codexEvent('user_message', at, { message: '修复真实用户任务' }) +
        codexEvent('task_started', at + 1) +
        codexEvent('task_complete', at + 2, { last_agent_message: POLLUTED_TITLE }),
    );
    useCodexManifest(fixture);
    await fixture.monitor.scan();
    poisonTitle(fixture);
    const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
    expect(previous.offset).toBe(Buffer.byteLength(readFileSync(fixture.source)));
    const before = getSession(fixture.engine.database, CODEX_SESSION_ID)!;
    const events = listEvents(fixture.engine.database);
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    const onCapture = rebuildMonitor(fixture);
    expect(await fixture.monitor.capture()).toBe(0);
    await fixture.monitor.capture();
    expect(getSession(fixture.engine.database, CODEX_SESSION_ID)).toEqual({
      ...before,
      title: '修复真实用户任务',
    });
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toEqual({
      ...previous,
      title: '修复真实用户任务',
    });
    expect(listEvents(fixture.engine.database)).toEqual(events);
    expect(onTransition).not.toHaveBeenCalled();
    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it('clears a legacy internal JSON title when no real user title exists', async () => {
    const at = Date.now() - 5000;
    const fixture = makeHarness(
      codexEvent('task_started', at) +
        codexEvent('task_complete', at + 1, { last_agent_message: POLLUTED_TITLE }),
    );
    useCodexManifest(fixture);
    await fixture.monitor.scan();
    poisonTitle(fixture);
    const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
    const before = getSession(fixture.engine.database, CODEX_SESSION_ID)!;
    const events = listEvents(fixture.engine.database);
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    const onCapture = rebuildMonitor(fixture);
    await fixture.monitor.capture();
    expect(getSession(fixture.engine.database, CODEX_SESSION_ID)).toEqual({
      ...before,
      title: null,
    });
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toEqual({
      ...previous,
      title: null,
    });
    expect(listEvents(fixture.engine.database)).toEqual(events);
    expect(onTransition).not.toHaveBeenCalled();
    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it('updates a consumed task title from a later user-only batch and refreshes the UI', async () => {
    const at = Date.now() - 5000;
    const fixture = makeHarness(codexEvent('task_started', at, { turn_id: 't1' }));
    useCodexManifest(fixture);
    await fixture.monitor.scan();
    const sessionId = CODEX_SESSION_ID + ':turn:t1';
    const before = getSession(fixture.engine.database, sessionId)!;
    const events = listEvents(fixture.engine.database);
    expect(before.title).toBeNull();
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    const onCapture = rebuildMonitor(fixture);
    appendFileSync(fixture.source, codexEvent('user_message', at + 1, { message: '增量用户标题' }));
    expect(await fixture.monitor.capture()).toBe(0);
    expect(getSession(fixture.engine.database, sessionId)).toEqual({
      ...before,
      title: '增量用户标题',
    });
    expect(listEvents(fixture.engine.database)).toEqual(events);
    expect(onTransition).not.toHaveBeenCalled();
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.context).toMatchObject({
      taskId: 't1',
      title: '增量用户标题',
    });
  });

  it('repairs persisted turn context from the consumed prefix before later events reuse its title', async () => {
    const at = Date.now() - 5000;
    const title = '修复上下文中的旧标题';
    const fixture = makeHarness(
      codexEvent('task_started', at, { turn_id: 't1' }) +
        codexEvent('user_message', at + 1, { message: title }),
    );
    useCodexManifest(fixture);
    await fixture.monitor.scan();
    const sessionId = CODEX_SESSION_ID + ':turn:t1';
    const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
    updateSessionTitle(fixture.engine.database, sessionId, POLLUTED_TITLE);
    saveSourceCheckpoint(fixture.engine.database, {
      ...previous,
      title: POLLUTED_TITLE,
      context: {
        taskId: 't1',
        title: POLLUTED_TITLE,
        closed: false,
        pendingTitle: '不应带入下一轮',
      },
    });
    appendFileSync(fixture.source, codexEvent('task_complete', at + 2, { turn_id: 't1' }));
    rebuildMonitor(fixture);
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    await fixture.monitor.capture();
    expect(getSession(fixture.engine.database, sessionId)).toMatchObject({
      title,
      currentState: 'completed',
    });
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.context).toEqual({
      taskId: 't1',
      title,
      closed: true,
    });
    expect(listEvents(fixture.engine.database)).toHaveLength(2);
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition.mock.calls[0]?.[1]?.payload.taskTitle).toBe(title);
  });

  it('keeps turns independent across captures and restores task context after Engine restart', async () => {
    const at = Date.now() - 10_000;
    const fixture = makeHarness(
      codexEvent('task_started', at, { turn_id: 't1' }) +
        codexEvent('user_message', at + 1, { message: '第一轮任务' }),
    );
    useCodexManifest(fixture);
    await fixture.monitor.scan();
    appendFileSync(fixture.source, codexEvent('task_complete', at + 2, { turn_id: 't1' }));
    await fixture.monitor.capture();
    appendFileSync(fixture.source, codexEvent('user_message', at + 3, { message: '第二轮任务' }));
    await fixture.monitor.capture();
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.context).toMatchObject({
      taskId: 't1',
      closed: true,
      pendingTitle: '第二轮任务',
    });
    fixture.monitor.stop();
    await fixture.engine.stop();
    fixture.engine = new Engine(fixture.dataDir);
    rebuildMonitor(fixture);
    appendFileSync(fixture.source, codexEvent('task_started', at + 4, { turn_id: 't2' }));
    await fixture.monitor.capture();
    expect(getSession(fixture.engine.database, CODEX_SESSION_ID + ':turn:t1')).toMatchObject({
      title: '第一轮任务',
      currentState: 'completed',
    });
    expect(getSession(fixture.engine.database, CODEX_SESSION_ID + ':turn:t2')).toMatchObject({
      title: '第二轮任务',
      currentState: 'running',
    });
    fixture.monitor.stop();
    await fixture.engine.stop();
    fixture.engine = new Engine(fixture.dataDir);
    rebuildMonitor(fixture);
    appendFileSync(fixture.source, codexEvent('task_complete', at + 5, { turn_id: 't2' }));
    await fixture.monitor.capture();
    expect(listSessions(fixture.engine.database)).toHaveLength(2);
    expect(getSession(fixture.engine.database, CODEX_SESSION_ID + ':turn:t2')).toMatchObject({
      title: '第二轮任务',
      currentState: 'completed',
    });
    expect(listEvents(fixture.engine.database)).toHaveLength(4);
    expect(listEvents(fixture.engine.database, { eventType: 'anomaly' })).toHaveLength(0);
  });

  it('restores legacy context only through the consumed prefix without leaking the next turn title', async () => {
    const at = Date.now() - 10_000;
    const fixture = makeHarness(
      codexEvent('task_started', at, { turn_id: 't1' }) +
        codexEvent('user_message', at + 1, { message: '已消费的第一轮' }) +
        codexEvent('task_complete', at + 2, { turn_id: 't1' }),
    );
    useCodexManifest(fixture);
    await fixture.monitor.scan();
    const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
    saveSourceCheckpoint(fixture.engine.database, { ...previous, context: null });
    appendFileSync(
      fixture.source,
      codexEvent('task_started', at + 3, { turn_id: 't2' }) +
        codexEvent('user_message', at + 4, { message: '第二轮独有标题' }) +
        codexEvent('task_complete', at + 5, { turn_id: 't2' }),
    );
    rebuildMonitor(fixture);
    await fixture.monitor.capture();
    expect(getSession(fixture.engine.database, CODEX_SESSION_ID + ':turn:t2')).toMatchObject({
      title: '第二轮独有标题',
      currentState: 'completed',
    });
    expect(
      getSourceCheckpoint(fixture.engine.database, fixture.source)?.context?.pendingTitle,
    ).toBeUndefined();
    appendFileSync(fixture.source, codexEvent('task_started', at + 6, { turn_id: 't3' }));
    await fixture.monitor.capture();
    expect(getSession(fixture.engine.database, CODEX_SESSION_ID + ':turn:t3')).toMatchObject({
      title: null,
      currentState: 'running',
    });
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.context).toMatchObject({
      taskId: 't3',
      title: null,
      closed: false,
    });
    expect(
      getSourceCheckpoint(fixture.engine.database, fixture.source)?.context?.pendingTitle,
    ).toBeUndefined();
    expect(listEvents(fixture.engine.database)).toHaveLength(5);
    expect(listEvents(fixture.engine.database, { eventType: 'anomaly' })).toHaveLength(0);
  });

  it.each(['privacy', 'ignored'] as const)(
    'does not commit an in-flight metadata repair after %s revocation',
    async (setting) => {
      const at = Date.now() - 5000;
      const fixture = makeHarness(
        codexEvent('user_message', at, { message: '应取消的标题修复' }) +
          codexEvent('task_started', at + 1),
      );
      useCodexManifest(fixture);
      await fixture.monitor.scan();
      poisonTitle(fixture);
      const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
      const before = getSession(fixture.engine.database, CODEX_SESSION_ID)!;
      const events = listEvents(fixture.engine.database);
      const onCapture = rebuildMonitor(fixture);
      const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let release!: () => void;
      let reachedHead!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const readingHead = new Promise<void>((resolve) => {
        reachedHead = resolve;
      });
      vi.mocked(fsPromises.open).mockImplementationOnce(async (file, flags, mode) => {
        const handle = await realFs.open(file, flags, mode);
        let reads = 0;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'read')
              return async (...args: unknown[]) => {
                const result: unknown = await Reflect.apply(target.read, target, args);
                reads += 1;
                if (reads === 3) {
                  reachedHead();
                  await held;
                }
                return result;
              };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
      const pending = fixture.monitor.capture();
      await readingHead;
      if (setting === 'privacy') fixture.settings.privacy.sessionFileRead = false;
      else fixture.settings.scan.ignoredToolIds = ['codex'];
      fixture.monitor.reconfigure();
      // 设置撤销本身通知界面清理；暂停中的旧批次不得再产生修复回调。
      expect(onCapture).toHaveBeenCalledTimes(1);
      onCapture.mockClear();
      release();
      await pending;
      expect(getSession(fixture.engine.database, CODEX_SESSION_ID)).toEqual(before);
      expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toEqual(previous);
      expect(listEvents(fixture.engine.database)).toEqual(events);
      expect(onCapture).not.toHaveBeenCalled();
    },
  );

  it('does not restart capture after stop while installation detection is in flight', async () => {
    const fixture = makeHarness(initialRows());
    const onScanComplete = vi.fn();
    fixture.monitor = new MonitorService({
      db: fixture.engine.database,
      engine: fixture.engine,
      getSettings: () => fixture.settings,
      resourcesDir: fixture.adaptersDir,
      onScanComplete,
    });
    const detector = (
      fixture.monitor as unknown as { orchestrator: { scan: () => Promise<ScanReport> } }
    ).orchestrator;
    let finishDetection!: (report: ScanReport) => void;
    vi.spyOn(detector, 'scan').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDetection = resolve;
        }),
    );
    const pending = fixture.monitor.scan();
    fixture.monitor.stop();
    vi.mocked(fsPromises.open).mockClear();
    finishDetection({
      results: [],
      degraded: [],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    await Promise.allSettled([pending]);
    expect(fsPromises.open).not.toHaveBeenCalled();
    expect(listSessions(fixture.engine.database)).toHaveLength(0);
    expect(listEvents(fixture.engine.database)).toHaveLength(0);
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toBeUndefined();
    expect(onScanComplete).not.toHaveBeenCalled();
  });

  it('orders source batch events before applying workflow transitions', async () => {
    const fixture = makeHarness('');
    await fixture.monitor.scan();
    const at = Date.now() - 5000;
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    await fixture.engine.consumeSourceBatch(
      [
        createStandardEvent({
          sessionId: SESSION_ID,
          toolId: 'fixture-agent',
          eventType: 'task.completed',
          occurredAt: new Date(at + 2000).toISOString(),
        }),
        createStandardEvent({
          sessionId: SESSION_ID,
          toolId: 'fixture-agent',
          eventType: 'task.started',
          occurredAt: new Date(at).toISOString(),
        }),
      ],
      {
        sourcePath: fixture.source,
        toolId: 'fixture-agent',
        fileIdentity: 'synthetic-batch',
        offset: 0,
        prefixHash: '',
        title: null,
        updatedAt: new Date().toISOString(),
      },
    );
    const session = listSessions(fixture.engine.database)[0];
    expect(session?.currentState).toBe('completed');
    expect(session?.startedAt).toBe(new Date(at).toISOString());
    expect(session?.endedAt).toBe(new Date(at + 2000).toISOString());
    expect(onTransition.mock.calls.map(([result]) => result.eventType)).toEqual([
      'task.started',
      'task.completed',
    ]);
  });

  it.each([false, true])(
    'records late source events as anomalies without regressing persisted state (restart=%s)',
    async (restart) => {
      const at = Date.now() - 1000;
      const fixture = makeHarness(initialRows(at));
      await fixture.monitor.scan();
      const initialSession = listSessions(fixture.engine.database)[0]!;
      if (restart) {
        fixture.monitor.stop();
        await fixture.engine.stop();
        fixture.engine = new Engine(fixture.dataDir);
        fixture.monitor = new MonitorService({
          db: fixture.engine.database,
          engine: fixture.engine,
          getSettings: () => fixture.settings,
          resourcesDir: fixture.adaptersDir,
        });
      }
      const onTransition = vi.fn();
      fixture.engine.onTransition = onTransition;
      const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
      appendFileSync(fixture.source, `${row('result', at - 5000, { is_error: false })}\n`);
      await fixture.monitor.capture();
      await fixture.monitor.capture();
      const session = listSessions(fixture.engine.database)[0];
      expect(session?.currentState).toBe('running');
      expect(session?.updatedAt).toBe(initialSession.updatedAt);
      expect(session?.endedAt).toBeNull();
      const anomalies = listEvents(fixture.engine.database, { eventType: 'anomaly' });
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]?.nextState).toBeNull();
      expect(JSON.parse(anomalies[0]?.payload ?? '{}')).toMatchObject({
        originalEventType: 'task.completed',
      });
      expect(getSourceCheckpoint(fixture.engine.database, fixture.source)!.offset).toBeGreaterThan(
        previous.offset,
      );
      expect(onTransition).not.toHaveBeenCalled();
    },
  );

  it('consumes appended events even when heartbeat observed the new mtime first', async () => {
    const fixture = makeHarness(initialRows());
    await fixture.monitor.scan();
    const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
    appendFileSync(
      fixture.source,
      `${row('permission_request', Date.now(), { toolName: 'FixtureTool' })}\n`,
    );
    await tick(fixture.monitor);
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.offset).toBe(
      previous.offset,
    );
    await fixture.monitor.capture();
    expect(listSessions(fixture.engine.database)[0]?.currentState).toBe('waiting_human');
    expect(listEvents(fixture.engine.database)).toHaveLength(2);
  });

  it('does not commit a partial JSONL record and consumes it once after completion', async () => {
    const fixture = makeHarness(initialRows());
    await fixture.monitor.scan();
    const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
    const next = Buffer.from(
      `${row('permission_request', Date.now(), { note: '等待确认', toolName: 'FixtureTool' })}\n`,
    );
    const split = next.indexOf(Buffer.from('等待')) + 1;
    appendFileSync(fixture.source, next.subarray(0, split));
    await fixture.monitor.capture();
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.offset).toBe(
      previous.offset,
    );
    expect(listEvents(fixture.engine.database)).toHaveLength(1);
    appendFileSync(fixture.source, next.subarray(split));
    await fixture.monitor.capture();
    await fixture.monitor.capture();
    expect(listEvents(fixture.engine.database)).toHaveLength(2);
    expect(listSessions(fixture.engine.database)[0]?.currentState).toBe('waiting_human');
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)?.offset).toBe(
      previous.offset + next.length,
    );
  });

  it('does not replay events after rescan, truncation, file replacement, or Engine restart', async () => {
    const first = initialRows();
    const fixture = makeHarness(first);
    await fixture.monitor.scan();
    const complete = `${row('result', Date.now(), { is_error: false })}\n`;
    appendFileSync(fixture.source, complete);
    await fixture.monitor.capture();
    expect(listEvents(fixture.engine.database)).toHaveLength(2);
    await fixture.monitor.scan();
    writeFileSync(fixture.source, first);
    await fixture.monitor.capture();
    const replacement = `${fixture.source}.replacement`;
    writeFileSync(replacement, first + complete);
    renameSync(replacement, fixture.source);
    await fixture.monitor.capture();
    expect(listEvents(fixture.engine.database)).toHaveLength(2);
    expect(listSessions(fixture.engine.database)[0]?.currentState).toBe('completed');

    fixture.monitor.stop();
    await fixture.engine.stop();
    fixture.engine = new Engine(fixture.dataDir);
    fixture.monitor = new MonitorService({
      db: fixture.engine.database,
      engine: fixture.engine,
      getSettings: () => fixture.settings,
      resourcesDir: fixture.adaptersDir,
    });
    await fixture.monitor.scan();
    expect(listEvents(fixture.engine.database)).toHaveLength(2);
    expect(fixture.engine.getState(SESSION_ID)).toBe('completed');
  });

  it('rolls back checkpoint, database and actor state when the consumption transaction fails', async () => {
    const fixture = makeHarness(initialRows());
    await fixture.monitor.scan();
    const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    const inspection = createDatabase(path.join(fixture.dataDir, 'awm.db'));
    try {
      inspection.sqlite.exec(
        "CREATE TRIGGER fixture_reject_checkpoint BEFORE INSERT ON source_checkpoints BEGIN SELECT RAISE(ABORT, 'fixture checkpoint failure'); END;",
      );
      appendFileSync(fixture.source, `${row('result', Date.now(), { is_error: false })}\n`);
      await fixture.monitor.capture();
      expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toEqual(previous);
      expect(listEvents(fixture.engine.database)).toHaveLength(1);
      expect(fixture.engine.getState(SESSION_ID)).toBe('running');
      expect(onTransition).not.toHaveBeenCalled();
      inspection.sqlite.exec('DROP TRIGGER fixture_reject_checkpoint;');
      await fixture.monitor.capture();
      expect(listEvents(fixture.engine.database)).toHaveLength(2);
      expect(fixture.engine.getState(SESSION_ID)).toBe('completed');
      expect(onTransition).toHaveBeenCalledTimes(1);
    } finally {
      inspection.sqlite.close();
    }
  });

  it.each(['privacy', 'ignored'] as const)(
    'stops capture and timeout immediately after %s is changed',
    async (setting) => {
      const at = Date.now() - 40 * 60_000;
      const fixture = makeHarness(initialRows(at) + `${row('permission_request', at + 2)}\n`);
      await fixture.monitor.scan();
      expect(fixture.engine.getState(SESSION_ID)).toBe('waiting_human');
      const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
      if (setting === 'privacy') fixture.settings.privacy.sessionFileRead = false;
      else fixture.settings.scan.ignoredToolIds = ['fixture-agent'];
      fixture.monitor.reconfigure();
      vi.mocked(fsPromises.open).mockClear();
      vi.mocked(fsPromises.readFile).mockClear();
      appendFileSync(fixture.source, `${row('result', Date.now(), { is_error: true })}\n`);
      await fixture.monitor.capture();
      await tick(fixture.monitor);
      await fixture.engine.stop();
      expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toEqual(previous);
      expect(listEvents(fixture.engine.database)).toHaveLength(2);
      expect(listSessions(fixture.engine.database)[0]?.currentState).toBe('waiting_human');
      expect(fsPromises.open).not.toHaveBeenCalled();
      expect(fsPromises.readFile).not.toHaveBeenCalled();
    },
  );

  it('revokes an in-flight capture before it can commit after privacy changes', async () => {
    const fixture = makeHarness(initialRows());
    await fixture.monitor.scan();
    const previous = getSourceCheckpoint(fixture.engine.database, fixture.source)!;
    appendFileSync(fixture.source, `${row('permission_request', Date.now())}\n`);
    const pending = fixture.monitor.capture();
    fixture.settings.privacy.sessionFileRead = false;
    fixture.monitor.reconfigure();
    await pending;
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toEqual(previous);
    expect(listEvents(fixture.engine.database)).toHaveLength(1);
  });

  it.each(['privacy', 'ignored'] as const)(
    'does not start content reads after %s revokes a pending open',
    async (setting) => {
      const fixture = makeHarness(initialRows());
      const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let release!: () => void;
      let reachedOpen!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const opening = new Promise<void>((resolve) => {
        reachedOpen = resolve;
      });
      const readContent = vi.fn();
      vi.mocked(fsPromises.open).mockImplementationOnce(async (file, flags, mode) => {
        const handle = await realFs.open(file, flags, mode);
        reachedOpen();
        await held;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'read') return readContent;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
      const pending = fixture.monitor.capture();
      await opening;
      if (setting === 'privacy') fixture.settings.privacy.sessionFileRead = false;
      else fixture.settings.scan.ignoredToolIds = ['fixture-agent'];
      fixture.monitor.reconfigure();
      release();
      expect(await pending).toBe(0);
      expect(readContent).not.toHaveBeenCalled();
      expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toBeUndefined();
      expect(listEvents(fixture.engine.database)).toEqual([]);
    },
  );
});

describe('capture announcement baseline', () => {
  it('broadcasts historical turns with the same title once each without requesting announcements', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const content = [1, 2, 3]
      .map(
        (turn) =>
          codexEvent('task_started', now - 10_000 + turn * 10, { turn_id: `old-${turn}` }) +
          codexEvent('user_message', now - 10_000 + turn * 10 + 1, {
            message: '同一个历史任务标题',
          }) +
          codexEvent('task_complete', now - 10_000 + turn * 10 + 2, { turn_id: `old-${turn}` }),
      )
      .join('');
    const fixture = makeHarness(content);
    useCodexManifest(fixture);
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    await fixture.monitor.capture();
    expect(listSessions(fixture.engine.database)).toHaveLength(3);
    expect(listEvents(fixture.engine.database)).toHaveLength(6);
    expect(onTransition).toHaveBeenCalledTimes(6);
    expect(onTransition.mock.calls.every(([, , delivery]) => delivery.announce === false)).toBe(
      true,
    );
    expect(
      onTransition.mock.calls
        .filter(([result]) => result.eventType === 'task.started')
        .map(([, event]) => event.payload.taskTitle),
    ).toEqual(['同一个历史任务标题', '同一个历史任务标题', '同一个历史任务标题']);
    await fixture.monitor.capture();
    expect(onTransition).toHaveBeenCalledTimes(6);
  });

  it('keeps the same silent baseline while an initial large file spans multiple capture batches', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const padding = `${row('padding', now - 40_000, { data: 'x'.repeat(700_000) })}\n`.repeat(7);
    const content =
      codexEvent('task_started', now - 60_000, { turn_id: 'first' }) +
      codexEvent('task_complete', now - 59_000, { turn_id: 'first' }) +
      padding +
      codexEvent('task_started', now - 20_000, { turn_id: 'second' }) +
      codexEvent('task_complete', now - 19_000, { turn_id: 'second' });
    const fixture = makeHarness(content);
    useCodexManifest(fixture);
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    await fixture.monitor.capture();
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)!.offset).toBeLessThan(
      Buffer.byteLength(content),
    );
    expect(onTransition).toHaveBeenCalledTimes(2);
    await fixture.monitor.capture();
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)!.offset).toBe(
      Buffer.byteLength(content),
    );
    expect(listEvents(fixture.engine.database)).toHaveLength(4);
    expect(onTransition).toHaveBeenCalledTimes(4);
    expect(onTransition.mock.calls.every(([, , delivery]) => delivery.announce === false)).toBe(
      true,
    );
  });

  it('does not request announcements for offline increments even when a checkpoint already exists', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = now;
    const fixture = makeHarness(codexEvent('task_started', first - 1000, { turn_id: 'one' }));
    useCodexManifest(fixture);
    await fixture.monitor.capture();
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toBeDefined();
    appendFileSync(fixture.source, codexEvent('task_complete', first + 1000, { turn_id: 'one' }));
    now = first + 10_000;
    rebuildMonitor(fixture);
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    await fixture.monitor.capture();
    expect(getSession(fixture.engine.database, `${CODEX_SESSION_ID}:turn:one`)?.currentState).toBe(
      'completed',
    );
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition.mock.calls[0]?.[2]).toEqual({ announce: false });
  });

  it('requests the real first start of a newly discovered file and rejects duplicate aliases', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fixture = makeHarness('');
    useCodexManifest(fixture);
    rmSync(fixture.source);
    writeFileSync(fixture.source, codexEvent('task_started', now + 1, { turn_id: 'new-chat' }));
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    await fixture.monitor.capture();
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition.mock.calls[0]?.[2]).toEqual({ announce: true });
    appendFileSync(fixture.source, codexEvent('turn_started', now + 2, { turn_id: 'new-chat' }));
    await fixture.monitor.capture();
    await fixture.monitor.capture();
    expect(onTransition).toHaveBeenCalledTimes(1);
  });

  it('never requests an announcement for a synthetic bootstrap start', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fixture = makeHarness(`${row('permission_request', now + 1)}\n`);
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    await fixture.monitor.capture();
    expect(
      onTransition.mock.calls.map(([result, , delivery]) => [result.eventType, delivery.announce]),
    ).toEqual([
      ['task.started', false],
      ['task.waiting_human', true],
    ]);
    expect(listEvents(fixture.engine.database)).toHaveLength(2);
  });

  it('resets the baseline on reconfigure while later live starts still request announcements', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = now;
    const fixture = makeHarness('');
    useCodexManifest(fixture);
    appendFileSync(fixture.source, codexEvent('task_started', first + 1, { turn_id: 'before' }));
    now = first + 100;
    fixture.monitor.reconfigure();
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    await fixture.monitor.capture();
    appendFileSync(fixture.source, codexEvent('task_started', first + 101, { turn_id: 'after' }));
    await fixture.monitor.capture();
    expect(onTransition.mock.calls.map(([, , delivery]) => delivery.announce)).toEqual([
      false,
      true,
    ]);
  });

  it('retains the two-argument transition callback when no delivery filter is supplied', async () => {
    const fixture = makeHarness('');
    await fixture.monitor.capture();
    const onTransition = vi.fn();
    fixture.engine.onTransition = onTransition;
    await fixture.engine.consumeSourceBatch(
      [
        createStandardEvent({
          sessionId: SESSION_ID,
          toolId: 'fixture-agent',
          eventType: 'task.started',
        }),
      ],
      {
        sourcePath: fixture.source,
        toolId: 'fixture-agent',
        fileIdentity: 'synthetic-compatibility',
        offset: 0,
        prefixHash: 'synthetic-prefix',
        title: null,
        updatedAt: new Date().toISOString(),
      },
    );
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition.mock.calls[0]).toHaveLength(2);
  });
});

describe('capture capability boundaries', () => {
  it('keeps metadata snapshots outside the workflow sessions and clears them when disabled', async () => {
    const fixture = makeHarness('', 'metadata');
    const conversation = path.join(fixture.root, 'never-open-conversation.json');
    writeFileSync(conversation, 'must never be parsed');
    writeFileSync(
      fixture.index,
      JSON.stringify([
        {
          id: 'history-1',
          task: '历史索引标题',
          ts: Date.now(),
          status: 'completed',
          path: conversation,
        },
      ]),
    );
    await fixture.monitor.scan();
    expect(fixture.monitor.historyTasks).toMatchObject([
      { kind: 'history', title: '历史索引标题', currentState: null },
    ]);
    expect(listSessions(fixture.engine.database)).toHaveLength(0);
    expect(listEvents(fixture.engine.database)).toHaveLength(0);
    expect(vi.mocked(fsPromises.readFile).mock.calls.some(([file]) => file === conversation)).toBe(
      false,
    );
    await tick(fixture.monitor);
    expect(listEvents(fixture.engine.database)).toHaveLength(0);
    fixture.settings.privacy.sessionFileRead = false;
    fixture.monitor.reconfigure();
    expect(fixture.monitor.historyTasks).toEqual([]);
  });

  it('does not open a detect-only adapter placeholder source', async () => {
    const fixture = makeHarness(
      'SQLite format 3\u0000\ufffdprivate-shaped-placeholder',
      'detect-only',
    );
    vi.mocked(fsPromises.open).mockClear();
    vi.mocked(fsPromises.readFile).mockClear();
    await fixture.monitor.scan();
    await fixture.monitor.capture();
    expect(fsPromises.open).not.toHaveBeenCalled();
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    expect(getSourceCheckpoint(fixture.engine.database, fixture.source)).toBeUndefined();
    expect(listSessions(fixture.engine.database)).toHaveLength(0);
    expect(listEvents(fixture.engine.database)).toHaveLength(0);
  });
});
