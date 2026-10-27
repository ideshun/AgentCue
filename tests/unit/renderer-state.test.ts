/** Renderer regressions use synthetic state and isolated scripts, without Electron or private data. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { inRange, voiceTaskTitle } from '@awm/core';
import { DEFAULT_CLOUD_ENDPOINT } from '@awm/schema';

/** @description: Evaluate the native script bundle with boot deferred and a minimal host. */
function renderer(): vm.Context {
  const context = vm.createContext({
    URLSearchParams,
    AbortSignal,
    setTimeout,
    clearTimeout,
    window: {
      location: { hash: '#/overview' },
      setTimeout,
      clearTimeout,
      awm: { platform: 'darwin' },
    },
    document: { readyState: 'loading', addEventListener() {}, activeElement: null },
    HTMLElement: class {},
    HTMLInputElement: class {},
    HTMLSelectElement: class {},
    HTMLTextAreaElement: class {},
  });
  for (const name of ['api', 'ui', 'views', 'office', 'app']) {
    const source = readFileSync(path.resolve('apps/desktop/src/renderer', `${name}.ts`), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    vm.runInContext(compiled, context, { filename: `${name}.js` });
  }
  vm.runInContext('render = () => {}; renderChrome = () => {};', context);
  return context;
}
function evaluate<T>(context: vm.Context, expression: string): T {
  return vm.runInContext(expression, context) as T;
}
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
const settings = {
  schemaVersion: 1,
  scan: { autoIntervalHours: 6, ignoredToolIds: [], customTools: [] },
  voice: {
    enabled: true,
    rate: 1,
    volume: 0.8,
    backend: 'native',
    voiceProfile: 'system-default',
    scope: 'attention',
    content: 'title',
    cloudEnabled: false,
    cloudEndpoint: '',
  },
  quiet: {
    globalMute: false,
    waitingHumanOverride: true,
    ranges: [
      { from: '22:30', to: '08:30' },
      { from: '12:00', to: '13:00' },
    ],
  },
  privacy: { sessionFileRead: true, auditLog: true, scanScope: 'minimal' },
};

describe('renderer settings', () => {
  it('exposes broadcast scope and content selectors with the saved values selected', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(context, 'state.settings = settingsFixture');
    const markup = evaluate<string>(context, 'renderSettings(state)');
    expect(markup).toContain('data-setting="voice.scope"');
    expect(markup).toMatch(/value="attention" selected[^>]*>仅待确认/);
    expect(markup).toContain('data-setting="voice.content"');
    expect(markup).toMatch(/value="title" selected[^>]*>会话标题（精简）/);
    evaluate(context, 'state.settings.voice.scope = "milestones"');
    expect(evaluate<string>(context, 'renderSettings(state)')).toMatch(
      /value="milestones" selected[^>]*>待确认与开始\/完成/,
    );
  });

  it('sends numeric rates and preserves other quiet ranges', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(context, 'state.settings = settingsFixture');
    expect(plain(evaluate(context, 'buildPatch("voice.rate", "1.4")'))).toEqual({
      voice: { rate: 1.4 },
    });
    expect(plain(evaluate(context, 'buildPatch("quiet.ranges.0.from", "23:00")'))).toEqual({
      quiet: {
        ranges: [
          { from: '23:00', to: '08:30' },
          { from: '12:00', to: '13:00' },
        ],
      },
    });
    expect(() => evaluate(context, 'buildPatch("voice.rate", "invalid")')).toThrow('有效数字');
  });

  it('builds patches for broadcast scope and content, ignoring unknown enum values', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(context, 'state.settings = settingsFixture');
    expect(plain(evaluate(context, 'buildPatch("voice.scope", "milestones")'))).toEqual({
      voice: { scope: 'milestones' },
    });
    expect(plain(evaluate(context, 'buildPatch("voice.content", "prompt")'))).toEqual({
      voice: { content: 'prompt' },
    });
    expect(plain(evaluate(context, 'buildPatch("voice.scope", "everything")'))).toEqual({});
    expect(plain(evaluate(context, 'buildPatch("voice.content", "text")'))).toEqual({});
  });

  it('maps legacy all to the three milestones without offering a duplicate scope', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(context, 'state.settings = settingsFixture; state.settings.voice.scope = "all"');
    const markup = evaluate<string>(context, 'renderSettings(state)');
    expect(markup).toMatch(/value="milestones" selected[^>]*>待确认与开始\/完成/);
    expect(markup).not.toContain('<option value="all"');
    expect(evaluate(context, 'state.settings.voice.scope')).toBe('all');
  });

  it('disables rate only for cloud speech and preserves the saved local rate', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(
      context,
      'state.settings = settingsFixture; state.settings.voice.rate = 1.4; state.settings.voice.cloudApiKey = ""',
    );
    for (const backend of ['cloud', 'native', 'local']) {
      context.backendFixture = backend;
      evaluate(context, 'state.settings.voice.backend = backendFixture');
      const markup = evaluate<string>(context, 'renderSettings(state)');
      const rate = /<input[^>]*data-setting="voice.rate"[^>]*>/.exec(markup)?.[0] ?? '';
      expect(rate).toContain('value="1.4"');
      expect(rate.includes('disabled')).toBe(backend === 'cloud');
    }
    expect(evaluate(context, 'state.settings.voice.rate')).toBe(1.4);
  });

  it('builds queued patches from the last successful save', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const sent: Record<string, Record<string, unknown>>[] = [];
    let saved = structuredClone(settings);
    context.put = async (_path: string, patch: Record<string, Record<string, unknown>>) => {
      sent.push(plain(patch));
      saved = { ...saved, quiet: { ...saved.quiet, ...patch.quiet } };
      return structuredClone(saved);
    };
    evaluate(context, 'state.settings = settingsFixture; Api.put = put');
    const first = evaluate<Promise<void>>(
      context,
      'saveSettings(() => buildPatch("quiet.ranges.0.from", "23:00"))',
    );
    const second = evaluate<Promise<void>>(
      context,
      'saveSettings(() => buildPatch("quiet.ranges.1.to", "13:30"))',
    );
    await Promise.all([first, second]);
    expect(sent[1]).toEqual({
      quiet: {
        ranges: [
          { from: '23:00', to: '08:30' },
          { from: '12:00', to: '13:30' },
        ],
      },
    });
  });

  it('parses arguments as values rather than shell fragments', () => {
    const context = renderer();
    expect(
      plain(evaluate(context, 'parseMcpArgs(\'["-y","@org/server","path with spaces"]\')')),
    ).toEqual(['-y', '@org/server', 'path with spaces']);
    expect(plain(evaluate(context, 'parseMcpArgs("-y\\n@org/server\\npath with spaces")'))).toEqual(
      ['-y', '@org/server', 'path with spaces'],
    );
    expect(() => evaluate(context, 'parseMcpArgs("[1]")')).toThrow('字符串数组');
  });
});

describe('renderer board', () => {
  it('renders full group counts and keeps unknown history read-only', () => {
    const context = renderer();
    context.fixture = {
      groups: [
        {
          id: 'attention',
          total: 201,
          nextCursor: 'next',
          items: [
            {
              kind: 'session',
              sessionId: 's1',
              toolId: 'demo',
              title: '<script>unsafe</script>',
              currentState: 'waiting_human',
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        {
          id: 'history',
          total: 1,
          nextCursor: null,
          items: [
            {
              kind: 'history',
              sessionId: 'history-1',
              toolId: 'demo-extension',
              title: 'Historical record',
              currentState: null,
              updatedAt: new Date().toISOString(),
            },
          ],
        },
      ],
      generatedAt: new Date().toISOString(),
    };
    evaluate(context, 'state.board = fixture');
    const markup = evaluate<string>(context, 'renderBoard(state)');
    expect(markup).toContain('201');
    expect(markup).toContain('data-cursor="next"');
    expect(markup).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(markup).not.toContain('data-session="history-1"');
    expect(markup).not.toContain('data-task-id="history-1"');
    expect(markup).toContain('状态未知');
    expect(markup).toContain('标记已响应');
  });

  it('shows attention tasks from group queries even when the mixed session list omits them', () => {
    const context = renderer();
    evaluate(
      context,
      `state.overview = { counts: { waiting_human: 1, running: 0, completed: 200 }, attention: 1, tools: { total: 0, running: 0 }, adapters: 1, lastScan: null }; state.sessions = []; state.board = { groups: [{ id: 'attention', total: 1, nextCursor: null, items: [{ kind: 'session', sessionId: 'old-task', toolId: 'demo', title: 'Older task still waiting', currentState: 'waiting_human', updatedAt: '2026-10-01T00:00:00Z' }] }] };`,
    );
    expect(evaluate<string>(context, 'renderOverview(state)')).toContain(
      'Older task still waiting',
    );
  });

  it('refreshes more than 100 loaded rows with new cursors and removes moved records', async () => {
    const context = renderer();
    const items = Array.from({ length: 135 }, (_, index) => ({
      kind: 'session',
      sessionId: `current-${index}`,
      toolId: 'demo',
      title: `任务 ${index}`,
      currentState: 'completed',
      updatedAt: '2026-10-22T00:00:00Z',
    }));
    context.boardFixture = {
      groups: [
        {
          id: 'completed',
          total: 135,
          nextCursor: 'old-120',
          items: [{ ...items[0], sessionId: 'moved-away' }, ...items.slice(1, 120)],
        },
      ],
      generatedAt: 'old',
    };
    const requests: string[] = [];
    context.get = async (requestPath: string) => {
      requests.push(requestPath);
      if (requestPath.startsWith('/api/v1/board?')) {
        const params = new URLSearchParams(requestPath.split('?')[1]);
        const offset = Number(params.get('cursor') ?? 0);
        const end = Math.min(items.length, offset + Number(params.get('limit')));
        return {
          groups: [
            {
              id: 'completed',
              total: items.length,
              items: items.slice(offset, end),
              nextCursor: end < items.length ? String(end) : null,
            },
          ],
          generatedAt: 'new',
        };
      }
      return requestPath === '/api/v1/settings' ? structuredClone(settings) : [];
    };
    evaluate(
      context,
      'state.route = "board"; window.location.hash = "#/board"; state.board = boardFixture; Api.get = get',
    );
    await evaluate(context, 'refresh()');
    expect(evaluate(context, 'state.board.groups[0].items.length')).toBe(120);
    expect(evaluate(context, 'state.board.groups[0].nextCursor')).toBe('120');
    expect(evaluate(context, 'state.board.groups[0].total')).toBe(135);
    expect(evaluate(context, 'state.sessions.some(item => item.sessionId === "moved-away")')).toBe(
      false,
    );
    expect(requests.filter((url) => url.startsWith('/api/v1/board?'))).toEqual([
      '/api/v1/board?limit=20',
      '/api/v1/board?limit=100&group=completed&cursor=20',
    ]);
    await evaluate(context, 'loadBoardGroup("completed", "120")');
    expect(evaluate(context, 'state.board.groups[0].items.length')).toBe(135);
    expect(evaluate(context, 'state.board.groups[0].nextCursor')).toBeNull();
  });

  it('keeps a page loaded during refresh and defers automatic refresh while loading more', async () => {
    const context = renderer();
    const items = Array.from({ length: 160 }, (_, index) => ({
      kind: 'session',
      sessionId: `s-${index}`,
      toolId: 'demo',
      title: '任务',
      currentState: 'completed',
      updatedAt: '2026-10-22T00:00:00Z',
    }));
    context.boardFixture = {
      groups: [{ id: 'completed', total: 160, items: items.slice(0, 120), nextCursor: '120' }],
    };
    let releaseHead: (value: unknown) => void = () => {};
    let releaseMore: (value: unknown) => void = () => {};
    let delayHead = true;
    let delayMore = false;
    let calls = 0;
    const page = (offset: number, limit: number) => ({
      groups: [
        {
          id: 'completed',
          total: 160,
          items: items.slice(offset, offset + limit),
          nextCursor: String(offset + limit),
        },
      ],
    });
    context.get = async (url: string) => {
      calls += 1;
      if (!url.startsWith('/api/v1/board?'))
        return url === '/api/v1/settings' ? structuredClone(settings) : [];
      const params = new URLSearchParams(url.split('?')[1]);
      if (!params.has('cursor') && delayHead)
        return new Promise((resolve) => {
          releaseHead = resolve;
        });
      if (params.get('cursor') === '140' && delayMore)
        return new Promise((resolve) => {
          releaseMore = resolve;
        });
      return page(Number(params.get('cursor') ?? 0), Number(params.get('limit')));
    };
    evaluate(
      context,
      `state.route = 'board'; window.location.hash = '#/board'; state.board = boardFixture;
      Api.get = get; window.setTimeout = () => 1;`,
    );
    const refresh = evaluate<Promise<void>>(context, 'refresh()');
    await evaluate(context, 'loadBoardGroup("completed", "120")');
    releaseHead(page(0, 20));
    await refresh;
    expect(evaluate(context, 'state.board.groups[0].items.length')).toBe(140);
    expect(evaluate(context, 'state.board.groups[0].nextCursor')).toBe('140');
    delayHead = false;
    await evaluate(context, 'refresh()');
    expect(evaluate(context, 'state.board.groups[0].items.length')).toBe(140);
    delayMore = true;
    const more = evaluate<Promise<void>>(context, 'loadBoardGroup("completed", "140")');
    const before = calls;
    evaluate(context, 'backgroundRefreshAt = 0');
    await evaluate(context, 'refresh(true)');
    expect(calls).toBe(before);
    releaseMore({
      groups: [{ id: 'completed', total: 160, items: items.slice(140), nextCursor: null }],
    });
    await more;
    expect(evaluate(context, 'state.board.groups[0].items.length')).toBe(160);
  });

  it('keeps the full loaded window on a failed later page and discards pages after a filter change', async () => {
    const context = renderer();
    const items = Array.from({ length: 120 }, (_, index) => ({
      kind: 'session',
      sessionId: `s-${index}`,
      toolId: 'demo',
      title: '任务',
      currentState: 'completed',
      updatedAt: '2026-10-22T00:00:00Z',
    }));
    context.boardFixture = { groups: [{ id: 'completed', total: 130, items, nextCursor: '120' }] };
    let release: ((value: unknown) => void) | null = null;
    let failPage = true;
    context.get = async (requestPath: string) => {
      if (requestPath.startsWith('/api/v1/board?')) {
        if (requestPath.includes('cursor=')) {
          if (failPage) throw new Error('synthetic page failure');
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return {
          groups: [{ id: 'completed', total: 130, items: items.slice(0, 20), nextCursor: '20' }],
        };
      }
      return requestPath === '/api/v1/settings' ? structuredClone(settings) : [];
    };
    evaluate(
      context,
      'state.route = "board"; window.location.hash = "#/board"; state.board = boardFixture; Api.get = get',
    );
    await evaluate(context, 'refresh()');
    expect(evaluate(context, 'state.board.groups[0].items.length')).toBe(120);
    expect(evaluate(context, 'state.sectionErrors.board')).toContain('synthetic page failure');
    failPage = false;
    const pending = evaluate<Promise<void>>(context, 'refresh()');
    for (let index = 0; index < 10 && !release; index += 1) await Promise.resolve();
    expect(release).not.toBeNull();
    evaluate(context, 'state.boardQuery.q = "new filter"; state.board = null; ++loadSequence');
    release!({
      groups: [{ id: 'completed', total: 130, items: items.slice(20), nextCursor: null }],
    });
    await pending;
    expect(evaluate(context, 'state.board')).toBeNull();
  });
});

describe('renderer hook integrations', () => {
  const integration = {
    id: 'cline',
    name: 'Cline',
    files: [
      {
        path: '~/Documents/Cline/Hooks/TaskStart',
        content: '#!/bin/sh\nexec "/tmp/Synthetic App" --tool-hook cline --hook-phase TaskStart\n',
        executable: true,
      },
    ],
    steps: ['启用 Hooks 后合并脚本。'],
    commandReady: true,
    lastEventAt: null as string | null,
    enabled: true,
    capabilityReason: '开始与结束事件；等待确认尚未验证。',
  };

  it('distinguishes waiting, historical receipt, paused reception and an unavailable entry', () => {
    const context = renderer();
    context.integrationFixture = structuredClone(integration);
    evaluate(context, 'state.hookIntegrations = [integrationFixture]');
    const waiting = evaluate<string>(context, 'renderIntegrations(state)');
    expect(waiting).toContain('等待首次任务事件');
    expect(waiting).toContain('不代表持续连接');
    expect(waiting).toContain('收到事件后，是否出声仍取决于语音开关、全局静音、免打扰与事件规则');
    expect(waiting).toContain('已有设置或同名脚本请合并');
    expect(waiting).toContain('chmod u+x');
    expect(waiting).not.toContain('data-action="speak-test"');
    expect(waiting).not.toMatch(/data-action="(?:test-hook|send-event|start-task|stop-task)"/);
    evaluate(context, 'state.hookIntegrations[0].lastEventAt = "2020-01-01T00:00:00Z"');
    const received = evaluate<string>(context, 'renderIntegrations(state)');
    expect(received).toContain('已收到任务事件');
    expect(received).toContain('最近收到');
    expect(received).toContain('2020');
    expect(received).not.toContain('已连接');
    evaluate(context, 'state.hookIntegrations[0].enabled = false');
    const paused = evaluate<string>(context, 'renderIntegrations(state)');
    expect(paused).toContain('暂停接收');
    expect(paused).toContain('2020');
    evaluate(context, 'state.hookIntegrations[0].commandReady = false');
    const unavailable = evaluate<string>(context, 'renderIntegrations(state)');
    expect(unavailable).toContain('入口不可用');
    expect(unavailable).toContain('data-copy-unavailable="true"');
    expect(unavailable).toMatch(/aria-label="复制 Cline 配置 1" disabled/);
  });

  it('escapes displayed code but copies exact multiline source and never submits an event', async () => {
    const context = renderer();
    const content = '#!/bin/sh\n# <script>synthetic</script> & "quoted"\nexec "/tmp/Example App"\n';
    context.integrationFixture = {
      ...structuredClone(integration),
      files: [{ path: '~/Hooks/<TaskStart>', content, executable: true }],
    };
    const clipboard: string[] = [];
    context.navigator = {
      clipboard: {
        writeText: async (value: string) => {
          clipboard.push(value);
        },
      },
    };
    evaluate(context, 'state.hookIntegrations = [integrationFixture]');
    const markup = evaluate<string>(context, 'renderIntegrations(state)');
    expect(markup).toContain('&lt;script&gt;synthetic&lt;/script&gt;');
    expect(markup).toContain('~/Hooks/&lt;TaskStart&gt;');
    expect(markup).not.toContain('<script>');
    await evaluate<Promise<void>>(context, 'copyHookFile("cline", "~/Hooks/<TaskStart>")');
    expect(clipboard).toEqual([content]);
    await expect(
      evaluate<Promise<void>>(context, 'copyHookFile("cline", "missing")'),
    ).rejects.toThrow('已更新');
    evaluate(context, 'state.hookIntegrations[0].commandReady = false');
    await expect(
      evaluate<Promise<void>>(context, 'copyHookFile("cline", "~/Hooks/<TaskStart>")'),
    ).rejects.toThrow('入口不可用');
    expect(clipboard).toHaveLength(1);
  });

  it('retains both open and closed code disclosures across replacement', () => {
    const context = renderer();
    const before = [
      { dataset: { disclosureKey: 'hook-code-cline' }, open: true },
      { dataset: { disclosureKey: 'hook-code-cursor' }, open: false },
    ];
    const after = [
      { dataset: { disclosureKey: 'hook-code-cline' }, open: false },
      { dataset: { disclosureKey: 'hook-code-cursor' }, open: true },
    ];
    context.beforeRoot = { querySelectorAll: () => before };
    context.afterRoot = { querySelectorAll: () => after };
    evaluate(context, 'captureDisclosures(beforeRoot); restoreDisclosures(afterRoot)');
    expect(after.map((item) => item.open)).toEqual([true, false]);
  });

  it('keeps successful settings and old hook data when only the hook request fails', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.integrationFixture = structuredClone(integration);
    context.get = async (requestPath: string) => {
      if (requestPath === '/api/v1/integrations/hooks')
        throw new Error('synthetic hooks unavailable');
      if (requestPath === '/api/v1/settings') return structuredClone(settings);
      if (requestPath === '/api/v1/voice/voices') return { voices: [] };
      return [];
    };
    evaluate(
      context,
      'Api.get = get; state.route = "integrations"; window.location.hash = "#/integrations"; state.hookIntegrations = [integrationFixture]',
    );
    await evaluate<Promise<void>>(context, 'refresh()');
    expect(evaluate(context, 'state.settings.voice.enabled')).toBe(true);
    expect(evaluate(context, 'state.hookIntegrations[0].id')).toBe('cline');
    expect(evaluate<string>(context, 'state.sectionErrors.hooks')).toContain(
      'synthetic hooks unavailable',
    );
    expect(evaluate(context, 'state.sectionErrors.settings')).toBeUndefined();
  });

  it('discards a hook response after navigating away from integrations', async () => {
    const context = renderer();
    let resolveHooks: (value: unknown) => void = () => {};
    context.integrationFixture = structuredClone(integration);
    context.get = async (requestPath: string) => {
      if (requestPath === '/api/v1/integrations/hooks')
        return new Promise((resolve) => {
          resolveHooks = resolve;
        });
      if (requestPath === '/api/v1/settings') return structuredClone(settings);
      if (requestPath === '/api/v1/voice/voices') return { voices: [] };
      return [];
    };
    evaluate(
      context,
      'Api.get = get; state.route = "integrations"; window.location.hash = "#/integrations"',
    );
    const old = evaluate<Promise<void>>(context, 'refresh()');
    evaluate(context, 'window.location.hash = "#/overview"');
    await evaluate<Promise<void>>(context, 'refresh()');
    resolveHooks([structuredClone(integration)]);
    await old;
    expect(evaluate(context, 'state.route')).toBe('overview');
    expect(evaluate(context, 'state.hookIntegrations.length')).toBe(0);
  });

  it('separates installed extension state from task-event receipt on the tools page', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.toolsFixture = [
      {
        toolId: 'cline',
        name: 'Cline',
        detectStatus: 'installed',
        sessionCount: 0,
        hookSupported: true,
        hookLastEventAt: null,
      },
    ];
    context.adaptersFixture = [
      {
        id: 'cline',
        name: 'Cline',
        detect: { configPaths: [] },
        eventMapping: {},
        sessionCapability: 'metadata',
      },
    ];
    evaluate(
      context,
      'state.settings = settingsFixture; state.tools = toolsFixture; state.adapters = adaptersFixture',
    );
    const installed = evaluate<string>(context, 'renderAdapters(state)');
    expect(installed).toContain('已安装不代表任务事件已接入');
    expect(installed).toContain('等待首次任务事件');
    evaluate(
      context,
      'state.settings.privacy.sessionFileRead = false; state.tools[0].hookLastEventAt = "2020-01-01T00:00:00Z"',
    );
    const paused = evaluate<string>(context, 'renderAdapters(state)');
    expect(paused).toContain('暂停接收任务事件');
    expect(paused).toContain('最近收到');
    expect(paused).not.toContain('已连接');
  });
});

describe('renderer task titles', () => {
  it('uses the same stable short number as voice for empty titles and distinct source ids', () => {
    const context = renderer();
    context.toolsFixture = [{ toolId: 'codex', name: 'Codex' }];
    const ids = [
      'codex:project-a:shared-suffix',
      'codex:project-b:shared-suffix',
      'codex:项目:重构😀',
    ];
    const displayed: string[] = [];
    for (const sessionId of ids) {
      for (const title of [undefined, null, '', ' \n\t ']) {
        context.taskFixture = { sessionId, toolId: 'codex', title };
        const result = evaluate<string>(context, 'displayTaskTitle(taskFixture, toolsFixture)');
        expect(result).toBe(
          `Codex · ${voiceTaskTitle({ sessionId, toolId: 'codex', eventType: 'task.started', title })}`,
        );
        displayed.push(result);
      }
    }
    expect(new Set(displayed).size).toBe(ids.length);
    expect(displayed[0]).toMatch(/^Codex · 任务 [0-9A-F]{8}$/);
  });

  it('preserves legitimate JSON and code titles and escapes fallback tool names', () => {
    const context = renderer();
    const titles = [
      '{"risk_level":"low","user_authorization":"explicit"}',
      '{"name":"demo","retry":3}',
      'const result = values.map(value => value + 1);',
      '<button>修复按钮</button>',
    ];
    for (const title of titles) {
      context.taskFixture = { sessionId: 'demo:task', toolId: 'demo', title: ` ${title} ` };
      expect(evaluate<string>(context, 'displayTaskTitle(taskFixture)')).toBe(title);
    }
    context.taskFixture = {
      kind: 'session',
      sessionId: 'demo:task',
      toolId: 'demo',
      title: null,
      currentState: 'running',
      updatedAt: new Date().toISOString(),
    };
    context.toolsFixture = [{ toolId: 'demo', name: '<unsafe>' }];
    const markup = evaluate<string>(context, 'boardCard(taskFixture, toolsFixture)');
    expect(markup).toContain('&lt;unsafe&gt; · 任务');
    expect(markup).not.toContain('<unsafe>');
  });

  it('shares one missing-title fallback across overview, board and drawer', async () => {
    const context = renderer();
    context.taskFixture = {
      kind: 'session',
      sessionId: 'codex:project:empty-title',
      toolId: 'codex',
      title: ' \n ',
      currentState: 'running',
      updatedAt: new Date().toISOString(),
    };
    context.toolsFixture = [{ toolId: 'codex', name: 'Codex' }];
    evaluate(
      context,
      'state.tools = toolsFixture; state.sessions = [taskFixture]; state.board = { groups: [{ id: "running", total: 1, nextCursor: null, items: [taskFixture] }] }',
    );
    const title = evaluate<string>(context, 'displayTaskTitle(taskFixture, state.tools)');
    expect(evaluate<string>(context, 'renderOverview(state)')).toContain(title);
    expect(evaluate<string>(context, 'renderBoard(state)')).toContain(title);
    const heading = { textContent: '' };
    context.nodes = {
      '#drawer': { hidden: true, querySelector: () => ({ focus() {} }) },
      '#drawer-body': { innerHTML: '', querySelector: () => null },
      '#drawer-title': heading,
      '#drawer-subtitle': { textContent: '' },
      '#app': { inert: false },
    };
    evaluate(context, 'qs = (selector) => nodes[selector]; Api.get = async () => []');
    await evaluate<Promise<void>>(context, 'openTimeline(taskFixture.sessionId)');
    expect(heading.textContent).toBe(title);
    evaluate(context, 'state.sessions = []');
    await evaluate<Promise<void>>(context, 'openTimeline(taskFixture.sessionId)');
    expect(heading.textContent).toBe(title);
  });
});

describe('renderer automatic voice policy', () => {
  const rules = ['task.started', 'task.waiting_human', 'task.completed'].map((scopeEvent) => ({
    ruleId: scopeEvent,
    scopeEvent,
    action: 'speak',
  }));

  it('matches core range boundaries, overnight and multiple periods in local time', () => {
    const context = renderer();
    context.rangesFixture = structuredClone(settings.quiet.ranges);
    const times = [
      [0, 0, true],
      [8, 30, true],
      [8, 31, false],
      [12, 0, true],
      [13, 0, true],
      [13, 1, false],
      [22, 29, false],
      [22, 30, true],
    ] as const;
    for (const [hours, minutes, expected] of times) {
      context.nowFixture = new Date(2026, 9, 21, hours, minutes);
      const result = evaluate<boolean>(context, 'inQuietPeriod(rangesFixture, nowFixture)');
      expect(result).toBe(expected);
      expect(result).toBe(
        settings.quiet.ranges.some((range) => inRange(hours * 60 + minutes, range)),
      );
    }
  });

  it('shows only the waiting-human exception during quiet periods and never bypasses rule mute', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.rulesFixture = structuredClone(rules);
    context.nowFixture = new Date(2026, 9, 21, 23, 0);
    evaluate(context, 'state.settings = settingsFixture; state.rules = rulesFixture');
    expect(
      plain(
        evaluate(
          context,
          'deriveVoicePolicy(state.settings, state.rules, nowFixture).items.map(item => item.action)',
        ),
      ),
    ).toEqual(['notify', 'speak', 'notify']);
    evaluate(context, 'state.settings.quiet.waitingHumanOverride = false');
    expect(
      plain(
        evaluate(
          context,
          'deriveVoicePolicy(state.settings, state.rules, nowFixture).items.map(item => item.action)',
        ),
      ),
    ).toEqual(['notify', 'notify', 'notify']);
    evaluate(
      context,
      'state.settings.quiet.waitingHumanOverride = true; state.rules[1].action = "mute"; state.rules[2].action = "notify"',
    );
    const policy = plain(
      evaluate<{ items: Array<{ ruleAction: string; action: string }> }>(
        context,
        'deriveVoicePolicy(state.settings, state.rules, nowFixture)',
      ),
    );
    expect(policy.items.map((item) => item.action)).toEqual(['notify', 'mute', 'notify']);
    expect(policy.items[1].ruleAction).toBe('mute');
    expect(policy.items[2].ruleAction).toBe('notify');
  });

  it('applies global mute and disabled voice to all speak rules without changing configuration', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.rulesFixture = structuredClone(rules);
    context.nowFixture = new Date(2026, 9, 21, 23, 0);
    evaluate(
      context,
      'state.settings = settingsFixture; state.rules = rulesFixture; state.settings.quiet.globalMute = true',
    );
    const before = evaluate<string>(context, 'JSON.stringify([state.settings, state.rules])');
    const muted = plain(
      evaluate<{ status: string; items: Array<{ action: string; reason: string }> }>(
        context,
        'deriveVoicePolicy(state.settings, state.rules, nowFixture)',
      ),
    );
    expect(muted.items.map((item) => item.action)).toEqual(['notify', 'notify', 'notify']);
    expect(muted.items.every((item) => item.reason === '全局静音')).toBe(true);
    expect(evaluate<string>(context, 'JSON.stringify([state.settings, state.rules])')).toBe(before);
    evaluate(
      context,
      'state.settings.quiet.globalMute = false; state.settings.voice.enabled = false',
    );
    const disabled = plain(
      evaluate<{ items: Array<{ action: string; reason: string }> }>(
        context,
        'deriveVoicePolicy(state.settings, state.rules, nowFixture)',
      ),
    );
    expect(
      disabled.items.every((item) => item.action === 'notify' && item.reason === '语音已关闭'),
    ).toBe(true);
  });

  it('shows saved generic rules, tool overrides, adapter prerequisites and the audition exception', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.rulesFixture = [
      { ruleId: 'wildcard', scopeEvent: '*', action: 'notify' },
      { ruleId: 'started', scopeEvent: 'task.started', action: 'speak' },
      { ruleId: 'waiting', scopeEvent: 'task.waiting_human', action: 'mute' },
      { ruleId: 'tool', scopeTool: 'codex', scopeEvent: 'task.started', action: 'mute' },
    ];
    context.nowFixture = new Date(2026, 9, 21, 14, 0);
    evaluate(context, 'state.settings = settingsFixture; state.rules = rulesFixture');
    const policy = plain(
      evaluate<{ hasToolOverrides: boolean; items: Array<{ action: string }> }>(
        context,
        'deriveVoicePolicy(state.settings, state.rules, nowFixture)',
      ),
    );
    expect(policy.hasToolOverrides).toBe(true);
    expect(policy.items.map((item) => item.action)).toEqual(['speak', 'mute', 'notify']);
    const markup = evaluate<string>(context, 'renderVoicePolicy(state, nowFixture)');
    expect(markup).toContain('本机 14:00 · 免打扰时段外');
    expect(markup).toContain('存在工具专属规则');
    expect(markup).toContain('自动提醒需要适配器提供对应任务事件');
    expect(markup).toContain('试听是单次播放，不受自动语音开关、全局静音和免打扰时段影响');
    // 当前播报状态只在「播报规则」出现一次，语音区不再重复同一张卡。
    expect(
      evaluate<string>(context, 'renderSettings(state)').match(/aria-label="当前自动播报策略"/g),
    ).toHaveLength(1);
    evaluate(context, 'state.sectionErrors.rules = "synthetic unavailable"');
    const failed = evaluate<string>(context, 'renderVoicePolicy(state, nowFixture)');
    expect(failed).toContain('规则暂不可用');
    expect(failed).not.toContain('aria-label="当前通用事件动作"');
  });

  it('uses wildcard or engine default actions when a generic exact-event rule is absent', () => {
    const context = renderer();
    expect(evaluate<string>(context, 'genericVoiceAction([], "task.started")')).toBe('speak');
    context.rulesFixture = [
      { ruleId: 'all', scopeEvent: '*', action: 'notify' },
      { ruleId: 'tool', scopeTool: 'codex', scopeEvent: 'task.started', action: 'mute' },
    ];
    expect(evaluate<string>(context, 'genericVoiceAction(rulesFixture, "task.started")')).toBe(
      'notify',
    );
    const matrix = evaluate<string>(context, 'renderRuleMatrix(rulesFixture)');
    const started = matrix.match(/<select id="rule-task.started"[^>]*>([\s\S]*?)<\/select>/)?.[1];
    expect(started).toContain('<option value="notify" selected>仅通知</option>');
  });

  it('allows speak only for start, waiting-human and completion and explains old speak rules', () => {
    const context = renderer();
    context.rulesFixture = [
      { ruleId: 'all', scopeEvent: '*', action: 'speak' },
      { ruleId: 'timeout', scopeEvent: 'task.timeout', action: 'mute' },
    ];
    const before = JSON.stringify(context.rulesFixture);
    const matrix = evaluate<string>(context, 'renderRuleMatrix(rulesFixture)');
    for (const event of ['task.started', 'task.waiting_human', 'task.completed']) {
      const options = matrix.match(
        new RegExp(`<select id="rule-${event}"[^>]*>([\\s\\S]*?)<\\/select>`),
      )?.[1];
      expect(options).toContain('<option value="speak" selected>播报</option>');
    }
    for (const event of ['task.failed', 'task.timeout']) {
      const options = matrix.match(
        new RegExp(`<select id="rule-${event}"[^>]*>([\\s\\S]*?)<\\/select>`),
      )?.[1];
      expect(options).not.toContain('value="speak"');
    }
    expect(matrix).toContain('原播报规则现按仅通知执行');
    expect(matrix).toContain('<option value="notify" selected>仅通知</option>');
    expect(matrix).toContain('<option value="mute" selected>静音</option>');
    expect(JSON.stringify(context.rulesFixture)).toBe(before);
    for (const event of [
      'task.cancelled',
      'task.failed',
      'task.timeout',
      'task.retried',
      'heartbeat.lost',
    ]) {
      context.eventFixture = event;
      expect(evaluate(context, 'voiceEventCanSpeak(eventFixture)')).toBe(false);
    }
  });
});

describe('renderer native voices', () => {
  it('keeps deprecated voice and rule drafts from blanking their safe select values', () => {
    const context = renderer();
    evaluate(
      context,
      `
      state.route = 'settings';
      const voiceControl = new HTMLSelectElement();
      voiceControl.id = 'setting-voice-voiceProfile';
      voiceControl.dataset = { setting: 'voice.voiceProfile' };
      voiceControl.options = [{ value: 'system-default' }, { value: 'Sinji' }];
      voiceControl.value = 'system-default';
      const ruleControl = new HTMLSelectElement();
      ruleControl.id = 'rule-task.failed';
      ruleControl.dataset = { ruleEvent: 'task.failed' };
      ruleControl.options = [{ value: 'notify' }, { value: 'mute' }];
      ruleControl.value = 'notify';
      const nodes = { [voiceControl.id]: voiceControl, [ruleControl.id]: ruleControl };
      document.getElementById = id => nodes[id] ?? null;
      document.querySelector = () => null;
      routeDrafts('settings').set(voiceControl.id, { value: 'Tingting', checked: false, revision: 1 });
      routeDrafts('settings').set(ruleControl.id, { value: 'speak', checked: false, revision: 2 });
      restoreDrafts();
    `,
    );
    expect(evaluate<string>(context, 'voiceControl.value')).toBe('system-default');
    expect(evaluate<string>(context, 'ruleControl.value')).toBe('notify');
    expect(evaluate<string>(context, 'routeDrafts("settings").get(voiceControl.id).value')).toBe(
      'Tingting',
    );
    evaluate(
      context,
      'routeDrafts("settings").set(voiceControl.id, { value: "Sinji", checked: false, revision: 3 }); restoreDrafts()',
    );
    expect(evaluate<string>(context, 'voiceControl.value')).toBe('Sinji');
  });

  it('stages the safe auto reset and writes it only on save', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const sent: unknown[] = [];
    let saved = structuredClone(settings);
    context.put = async (_path: string, patch: { voice?: Record<string, unknown> }) => {
      sent.push(plain(patch));
      saved = { ...saved, voice: { ...saved.voice, ...(patch.voice ?? {}) } };
      return structuredClone(saved);
    };
    evaluate(
      context,
      'state.settings = settingsFixture; state.settings.voice.voiceProfile = "Tingting"; Api.put = put; toast = () => {}; routeDrafts("settings").set("setting-voice-voiceProfile", { value: "Tingting", checked: false, revision: 1 })',
    );
    evaluate(context, 'renderSettings(state)');
    evaluate(context, 'useSafeVoiceProfile()');
    // 只是预览：不写盘，也不改动已保存的设置。
    expect(sent).toEqual([]);
    expect(evaluate<string>(context, 'state.settings.voice.voiceProfile')).toBe('Tingting');
    expect(evaluate<string>(context, 'workingSettings().voice.voiceProfile')).toBe(
      'system-default',
    );
    expect(evaluate<number>(context, 'pendingChangeCount()')).toBe(1);
    expect(evaluate(context, 'routeDrafts("settings").has("setting-voice-voiceProfile")')).toBe(
      false,
    );
    expect(await evaluate<Promise<boolean>>(context, 'savePendingSettings()')).toBe(true);
    expect(sent).toEqual([{ voice: { voiceProfile: 'system-default' } }]);
    expect(evaluate<string>(context, 'state.settings.voice.voiceProfile')).toBe('system-default');
    expect(evaluate(context, 'hasPendingChanges()')).toBe(false);
  });

  it('lists allowlisted system voices with labels, escapes names, and explains legacy profiles', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.voicesFixture = [
      {
        id: 'Sinji (Chinese (Hong Kong))',
        name: 'Sinji (Chinese (Hong Kong))',
        language: 'zh_HK',
      },
      { id: 'Tingting', name: 'Tingting', language: 'zh_CN' },
      { id: 'Meijia', name: 'Meijia', language: 'zh_TW' },
      {
        id: 'Eddy (Chinese (China mainland))',
        name: 'Eddy (Chinese (China mainland))',
        language: 'zh_CN',
      },
      { id: '<unsafe>', name: '<unsafe>', language: 'en_US' },
    ];
    evaluate(context, 'state.settings = settingsFixture; state.nativeVoices = voicesFixture');
    const markup = evaluate<string>(context, 'renderSettings(state)');
    expect(markup).toContain('value="system-default" selected');
    expect(markup).toContain('自动（普通话增强音色优先）');
    expect(markup).toContain('善怡 · 粤语');
    expect(markup).toContain('婷婷 · 普通话');
    expect(markup).toContain('美佳 · 台湾');
    expect(markup).toContain('value="&lt;unsafe&gt;"');
    expect(markup).not.toContain('value="<unsafe>"');
    evaluate(context, 'state.settings.voice.voiceProfile = "Saved voice <missing>"');
    const unknown = evaluate<string>(context, 'renderSettings(state)');
    expect(unknown).not.toContain('value="Saved voice');
    expect(unknown).toContain('原音色「Saved voice &lt;missing&gt;」');
    expect(unknown).toContain('播放已回退安全自动');
    expect(evaluate<string>(context, 'state.settings.voice.voiceProfile')).toBe(
      'Saved voice <missing>',
    );
    expect(plain(evaluate(context, 'buildPatch("voice.voiceProfile", "Tingting")'))).toEqual({
      voice: { voiceProfile: 'Tingting' },
    });
    const unsaved = evaluate<string>(context, 'renderSettings(state, "Unsaved voice")');
    expect(unsaved).toContain('原音色「Unsaved voice」');
    expect(unsaved).toContain('value="system-default" selected');
    // 增强款只放行普通话；同名台湾变体不进白名单，列表里不会再出现两条 Eddy。
    expect(markup.match(/Eddy · 普通话（增强）/g)).toHaveLength(1);
    expect(markup).not.toContain('（增强 · 台湾）');
  });

  it('renders the local backend with model card, kokoro picker, and strict backend notice', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.settingsFixture.voice.backend = 'local';
    context.settingsFixture.voice.voiceProfile = 'kokoro:58';
    evaluate(context, 'state.settings = settingsFixture');
    const missing = evaluate<string>(context, 'renderSettings(state)');
    expect(missing).toContain('data-action="download-model"');
    expect(missing).toContain('下载约 348MB');
    expect(missing).toContain('github.com');
    expect(missing).toContain('value="kokoro:58" selected');
    expect(missing).toContain('普通话男声 · zm_009');
    // 100 个普通话 + 3 个英语发音人（af_maple / af_sol / bf_vale）。
    expect(missing.match(/<option value="kokoro:/g)).toHaveLength(103);
    expect(missing).toContain('普通话女声 · zf_001');
    expect(missing).toContain('英语女声 · af_maple');
    expect(missing).not.toContain('toggle-kokoro-voices');
    expect(missing).not.toContain('自动（善怡粤语优先）');
    expect(missing).not.toContain('<option value="native" selected');
    context.settingsFixture.voice.voiceProfile = 'Sinji';
    evaluate(context, 'state.settings = settingsFixture');
    expect(evaluate<string>(context, 'renderSettings(state)')).toContain(
      '原音色「Sinji」不是可用的本地音色',
    );
    context.voicesFixture = [
      { id: 'Sinji', name: 'Sinji', language: 'zh_HK' },
      { id: 'Tingting', name: 'Tingting', language: 'zh_CN' },
    ];
    evaluate(
      context,
      'state.modelStatus = { state: "downloading", percent: 42, bytes: 145, totalBytes: 340 }; renderSettings(state)',
    );
    const downloading = evaluate<string>(context, 'renderSettings(state)');
    expect(downloading).toContain('42%');
    expect(downloading).toContain('data-action="cancel-model"');
    expect(downloading).toContain('<progress');
    expect(downloading).not.toContain('style="width');
    evaluate(
      context,
      'state.modelStatus = { state: "error", error: "network <broken>" }; renderSettings(state)',
    );
    const errored = evaluate<string>(context, 'renderSettings(state)');
    expect(errored).toContain('重试下载');
    expect(errored).toContain('network &lt;broken&gt;');
    expect(errored).toContain('不会改播系统音色');
    expect(errored).not.toContain('播报自动回落到系统原生语音');
    evaluate(context, 'state.modelStatus = { state: "ready" }; renderSettings(state)');
    expect(evaluate<string>(context, 'renderSettings(state)')).toContain(
      '运行时与播放会在首次试听时验证',
    );
  });

  it('renders the ZipVoice engine with its own model, reference audio and transcript', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(
      context,
      `state.settings = settingsFixture;
      state.settings.voice.backend = 'local';
      state.settings.voice.localEngine = 'zipvoice';
      state.settings.voice.zipvoiceReferencePath = '/Users/me/voice/reference.wav';
      state.settings.voice.zipvoiceReferenceText = '这是一段参考录音。';
      state.modelStatus = { state: 'ready', kind: 'kokoro' };
      state.zipvoiceModelStatus = { state: 'missing', kind: 'zipvoice' };`,
    );
    const markup = evaluate<string>(context, 'renderSettings(state)');
    expect(markup).toContain('data-setting="voice.localEngine"');
    expect(markup).toMatch(/value="zipvoice" selected[^>]*>ZipVoice/);
    expect(markup).toContain('尚未下载 ZipVoice 模型。');
    expect(markup).toContain('下载约 162MB');
    expect(markup).toContain('data-action="download-model" data-model-kind="zipvoice"');
    expect(markup).toContain('data-action="pick-zipvoice-reference"');
    expect(markup).toContain('value="reference.wav"');
    expect(markup).toContain('value="这是一段参考录音。"');
    expect(markup).toContain('参考录音与原文已就绪');
    // ZipVoice 没有预置发音人：Kokoro 音色列表与它的 ready 状态都不得冒充当前引擎。
    expect(markup).not.toContain('<option value="kokoro:');
    expect(markup).not.toContain('本地模型已就绪');
    expect(plain(evaluate(context, 'buildPatch("voice.localEngine", "zipvoice")'))).toEqual({
      voice: { localEngine: 'zipvoice' },
    });
    expect(plain(evaluate(context, 'buildPatch("voice.localEngine", "piper")'))).toEqual({});
    expect(
      plain(evaluate(context, 'buildPatch("voice.zipvoiceReferenceText", "录音原文")')),
    ).toEqual({ voice: { zipvoiceReferenceText: '录音原文' } });
    expect(() => evaluate(context, 'buildPatch("voice.zipvoiceReferenceText", "x".repeat(501))')).toThrow(
      '500',
    );
  });

  it('lays every setting row out as one label plus one control column', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.settingsFixture.voice.cloudApiKey = '';
    context.voicesFixture = [{ id: 'Tingting', name: 'Tingting', language: 'zh_CN' }];
    // 本地 Kokoro 的 select 曾直接拼接模板，__ID__ 未被替换，草稿和焦点都找不到控件。
    for (const backend of ['native', 'local', 'cloud']) {
      evaluate(
        context,
        `state.settings = settingsFixture; state.settings.voice.backend = '${backend}'; state.settings.voice.voiceProfile = '${backend === 'local' ? 'kokoro:12' : 'system-default'}'`,
      );
      expect(evaluate<string>(context, 'renderSettings(state)'), backend).not.toContain('__ID__');
    }

    evaluate(
      context,
      `state.settings.voice.backend = 'local'; state.settings.voice.voiceProfile = 'kokoro:12'`,
    );
    const local = evaluate<string>(context, 'renderSettings(state)');
    // 「音色」只由外层字段行提供；旧 picker 的重复标签和三栏网格已删除。
    expect(local.match(/class="field-label" for="setting-voice-voiceProfile">音色/g)).toHaveLength(1);
    expect(local).not.toContain('voice-field');
    expect(local).not.toContain('voice-fields');
    expect(local).not.toContain('model-card');
    expect(local).not.toContain('<div class="field-control"><div class="field-control">');

    evaluate(
      context,
      `state.settings.voice.backend = 'cloud'; state.settings.voice.voiceProfile = 'system-default'`,
    );
    const cloud = evaluate<string>(context, 'renderSettings(state)');
    expect(cloud).toContain('data-setting="voice.cloudApiKey"');
    expect(cloud).not.toContain('<div class="field-control"><div class="field-control">');
    // 接口地址默认填入真实地址，不再只靠 placeholder；已经是默认值时「恢复默认」不可点。
    expect(cloud).toContain(`value="${DEFAULT_CLOUD_ENDPOINT}"`);
    expect(cloud).toMatch(/data-action="reset-cloud-endpoint" disabled>/);
    // 没有 Key 时给出创建入口，点击交给系统浏览器。
    expect(cloud).toContain('href="https://platform.xiaomimimo.com/console/api-keys"');
    expect(cloud).toContain('target="_blank"');

    evaluate(context, `state.settings.voice.cloudEndpoint = 'https://tts.example.com/v1/audio'`);
    const customEndpoint = evaluate<string>(context, 'renderSettings(state)');
    expect(customEndpoint).toContain('value="https://tts.example.com/v1/audio"');
    expect(customEndpoint).not.toMatch(/data-action="reset-cloud-endpoint" disabled>/);
    evaluate(context, `state.settings.voice.cloudEndpoint = ''`);

    // 云音色是预置下拉：九个官方音色，空值按 MiMo 默认 mimo_default 呈现。
    const cloudVoiceOptions = (html: string) =>
      /<select[^>]*data-setting="voice\.cloudVoice"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ??
      '';
    const voiceOptions = cloudVoiceOptions(cloud);
    expect(voiceOptions, 'voice.cloudVoice should render as a select').not.toBe('');
    expect(voiceOptions.match(/<option/g)).toHaveLength(9);
    expect(voiceOptions).toContain(
      '<option value="mimo_default" selected>mimo_default（MiMo 默认）</option>',
    );
    expect(voiceOptions).not.toContain('自定义');
    expect(voiceOptions).not.toContain('default_zh');

    evaluate(context, `state.settings.voice.cloudVoice = 'default_zh'`);
    const customVoiceOptions = cloudVoiceOptions(evaluate<string>(context, 'renderSettings(state)'));
    expect(customVoiceOptions).toContain(
      '<option value="default_zh" selected>default_zh（自定义）</option>',
    );
    expect(customVoiceOptions.match(/<option/g)).toHaveLength(10);

    evaluate(context, `state.settings.voice.cloudVoice = '冰糖'`);
    const presetVoiceOptions = cloudVoiceOptions(
      evaluate<string>(context, 'renderSettings(state)'),
    );
    expect(presetVoiceOptions).toContain(
      '<option value="冰糖" selected>冰糖（中文女声）</option>',
    );
    expect(presetVoiceOptions.match(/<option/g)).toHaveLength(9);
    evaluate(
      context,
      `state.settings.voice.cloudVoice = ''; state.settings.voice.cloudEndpoint = ''`,
    );

    evaluate(
      context,
      `state.settings.voice.backend = 'local'; state.settings.voice.localEngine = 'zipvoice'`,
    );
    const zipvoice = evaluate<string>(context, 'renderSettings(state)');
    expect(zipvoice).toContain('class="field-label" for="zipvoice-reference-path"');
    expect(zipvoice).toContain('class="field-label" for="zipvoice-reference-text"');

    // 试听结果按实际本地引擎命名，不再一律写 Kokoro。
    expect(evaluate<string>(context, 'backendLabel("local", "zipvoice")')).toBe('本地 ZipVoice');
    expect(evaluate<string>(context, 'backendLabel("local", "kokoro")')).toBe('本地 Kokoro');
    expect(evaluate<string>(context, 'backendLabel("cloud")')).toBe('云 TTS（MiMo）');
    expect(evaluate<string>(context, 'backendLabel("native")')).toBe('系统原生');

    context.rulesFixture = [{ ruleId: 'all', scopeEvent: '*', action: 'notify' }];
    const matrix = evaluate<string>(context, 'renderRuleMatrix(rulesFixture)');
    // 五个事件各占一行，旧 .rule-matrix 容器已删除。
    expect(matrix.match(/class="field"/g)).toHaveLength(5);
    expect(matrix).not.toContain('rule-matrix');

    const external = evaluate<string>(context, 'renderExternalMcp(state)');
    expect(external).toContain('for="mcp-command"');
    expect(external).not.toContain('external-form');
    expect(external).not.toContain('input-group');
  });

  it('always exposes every voice as selectable while favorites only change the ordering', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(
      context,
      `state.settings = settingsFixture; state.settings.voice.backend = 'local';
      state.settings.voice.voiceProfile = 'kokoro:12';
      state.settings.voice.savedVoices = [{ profile: 'kokoro:3', name: '清晰 <女声>' }, { profile: 'kokoro:58', name: '男声播报' }];`,
    );
    const common = evaluate<string>(context, 'renderSettings(state)');
    expect(common).toContain('清晰 &lt;女声&gt; · 普通话女声 zf_001');
    expect(common).toContain('男声播报 · 普通话男声 zm_009');
    expect(common).toContain('value="kokoro:12" selected');
    expect(common).toContain('普通话女声 · zf_018');
    const options = Array.from(common.matchAll(/<option value="kokoro:(\d+)"([^>]*)>/g));
    // sid 0-2 为英语发音人，3-102 为普通话；103 条全部可选。
    expect(options.map((option) => Number(option[1])).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 103 }, (_, index) => index),
    );
    expect(common).toContain('英语女声 · af_maple');
    expect(common).toContain('英语女声 · bf_vale');
    expect(options.every((option) => !option[2].includes('disabled'))).toBe(true);
    expect(
      options.filter((option) => option[2].includes('selected')).map((option) => option[1]),
    ).toEqual(['12']);
    expect(common.indexOf('清晰 &lt;女声&gt;')).toBeLessThan(common.indexOf('普通话女声 · zf_002'));
    expect(common).toContain('zf_099');
    expect(common).toContain('zm_100');
  });

  it('stages voice-name favorites and saves them without changing the selected voice', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const sent: unknown[] = [];
    context.record = (patch: unknown): void => {
      sent.push(plain(patch));
    };
    evaluate(
      context,
      `state.settings = settingsFixture; state.settings.voice.backend = 'local';
      state.settings.voice.voiceProfile = 'kokoro:3';
      state.settings.voice.savedVoices = [{ profile: 'kokoro:58', name: '男声播报' }];
      const nameInput = new HTMLInputElement(); nameInput.value = '清晰女声';
      document.getElementById = id => id === 'kokoro-voice-name-3' ? nameInput : null;
      toast = () => {};
      Api.put = async (_url, patch) => {
        record(patch);
        return { ...state.settings, voice: { ...state.settings.voice, ...patch.voice } };
      };`,
    );
    evaluate(context, 'saveKokoroVoiceName()');
    // 暂存期间只改预览：不写盘，收藏立即出现在下拉顶部。
    expect(sent).toEqual([]);
    expect(plain(evaluate(context, 'workingSettings().voice.savedVoices'))).toEqual([
      { profile: 'kokoro:58', name: '男声播报' },
      { profile: 'kokoro:3', name: '清晰女声' },
    ]);
    expect(
      evaluate<string>(
        context,
        'renderSettings(state, undefined, workingSettings(), previewRules())',
      ).match(/<option value="kokoro:/g),
    ).toHaveLength(103);
    expect(await evaluate<Promise<boolean>>(context, 'savePendingSettings()')).toBe(true);
    expect(sent[0]).toEqual({
      voice: {
        savedVoices: [
          { profile: 'kokoro:58', name: '男声播报' },
          { profile: 'kokoro:3', name: '清晰女声' },
        ],
      },
    });
    evaluate(context, 'saveKokoroVoiceName(true)');
    expect(sent).toHaveLength(1);
    expect(plain(evaluate(context, 'workingSettings().voice.savedVoices'))).toEqual([
      { profile: 'kokoro:58', name: '男声播报' },
    ]);
    expect(await evaluate<Promise<boolean>>(context, 'savePendingSettings()')).toBe(true);
    expect(sent[1]).toEqual({
      voice: { savedVoices: [{ profile: 'kokoro:58', name: '男声播报' }] },
    });
    expect(evaluate(context, 'state.settings.voice.voiceProfile')).toBe('kokoro:3');
    expect(evaluate(context, 'hasPendingChanges()')).toBe(false);
  });

  it('normalizes model progress payloads and rejects unknown shapes', () => {
    const context = renderer();
    expect(
      plain(evaluate(context, 'normalizeModelStatus({ state: "downloading", percent: 7 })')),
    ).toEqual({
      state: 'downloading',
      percent: 7,
      bytes: undefined,
      totalBytes: undefined,
      error: undefined,
    });
    expect(evaluate(context, 'normalizeModelStatus({ state: "weird" })')).toBeNull();
    expect(evaluate(context, 'normalizeModelStatus(null)')).toBeNull();
    expect(
      evaluate(
        context,
        'normalizeModelStatus({ state: "error", error: "' + 'x'.repeat(500) + '" }).error.length',
      ),
    ).toBe(400);
    expect(
      evaluate(context, 'normalizeModelStatus({ state: "ready", percent: -5 }).percent'),
    ).toBeUndefined();
    // 两套模型状态互不覆盖：SSE 负载的 kind 决定写入哪一份。
    evaluate(
      context,
      `state.modelStatus = null; state.zipvoiceModelStatus = null;
      applyModelStatus('zipvoice', normalizeModelStatus({ state: 'downloading', percent: 12, kind: 'zipvoice' }))`,
    );
    expect(evaluate(context, 'state.zipvoiceModelStatus.percent')).toBe(12);
    expect(evaluate(context, 'state.modelStatus')).toBeNull();
  });

  it('retains saved settings and the default option after enumeration fails, then permits retry', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(
      context,
      'state.settings = settingsFixture; state.settings.voice.voiceProfile = "Saved voice"; state.route = "settings"; window.location.hash = "#/settings"',
    );
    context.get = async () => {
      throw new Error('synthetic voice list failure');
    };
    evaluate(context, 'Api.get = get');
    await evaluate<Promise<void>>(context, 'loadNativeVoices()');
    expect(evaluate(context, 'state.nativeVoicesLoading')).toBe(false);
    expect(evaluate<string>(context, 'state.sectionErrors.voices')).toContain(
      'synthetic voice list failure',
    );
    const failed = evaluate<string>(context, 'renderSettings(state)');
    expect(failed).toContain('value="system-default"');
    expect(failed).toContain('重试音色列表');
    expect(failed).toContain('原音色「Saved voice」');
    expect(failed).not.toContain('自动选择仍可使用');
    context.get = async () => ({
      voices: [{ id: 'Sinji', name: 'Sinji', language: 'zh_HK' }],
    });
    evaluate(context, 'Api.get = get');
    await evaluate<Promise<void>>(context, 'loadNativeVoices()');
    expect(evaluate(context, 'state.sectionErrors.voices')).toBeUndefined();
    expect(evaluate<string>(context, 'state.settings.voice.voiceProfile')).toBe('Saved voice');
    expect(evaluate<number>(context, 'state.nativeVoices.length')).toBe(1);
  });

  it('rejects older refreshes and responses arriving after leaving settings', async () => {
    const context = renderer();
    const pending: Array<(value: unknown) => void> = [];
    context.get = () => new Promise((resolve) => pending.push(resolve));
    evaluate(
      context,
      'Api.get = get; state.route = "settings"; window.location.hash = "#/settings"',
    );
    const first = evaluate<Promise<void>>(context, 'loadNativeVoices()');
    const second = evaluate<Promise<void>>(context, 'loadNativeVoices()');
    pending[1]({ voices: [{ id: 'new', name: 'New', language: 'zh_CN' }] });
    await second;
    pending[0]({ voices: [{ id: 'old', name: 'Old', language: 'zh_CN' }] });
    await first;
    expect(evaluate<string>(context, 'state.nativeVoices[0].id')).toBe('new');
    const leaving = evaluate<Promise<void>>(context, 'loadNativeVoices()');
    evaluate(context, 'window.location.hash = "#/overview"');
    pending[2]({ voices: [{ id: 'late', name: 'Late', language: 'zh_CN' }] });
    await leaving;
    expect(evaluate<string>(context, 'state.nativeVoices[0].id')).toBe('new');
    expect(evaluate(context, 'state.nativeVoicesLoading')).toBe(false);
  });

  it('waits for queued voice saves before auditioning the selected voice', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const pending: Array<(value: unknown) => void> = [];
    const spoken: string[] = [];
    context.put = () => new Promise((resolve) => pending.push(resolve));
    context.speak = async () => {
      spoken.push(evaluate<string>(context, 'state.settings.voice.voiceProfile'));
      return { ok: true, usedBackend: 'native', errors: [] };
    };
    evaluate(
      context,
      'state.settings = settingsFixture; Api.put = put; window.awm.speakTest = speak; toast = () => {}',
    );
    const first = evaluate<Promise<void>>(
      context,
      'saveSettings({ voice: { voiceProfile: "Sinji" } })',
    );
    const audition = evaluate<Promise<void>>(context, 'auditionVoice("synthetic test")');
    const second = evaluate<Promise<void>>(
      context,
      'saveSettings({ voice: { voiceProfile: "system-default" } })',
    );
    await Promise.resolve();
    expect(spoken).toEqual([]);
    pending[0]({
      ...structuredClone(settings),
      voice: { ...settings.voice, voiceProfile: 'Sinji' },
    });
    await first;
    expect(spoken).toEqual([]);
    pending[1]({
      ...structuredClone(settings),
      voice: { ...settings.voice, voiceProfile: 'system-default' },
    });
    await Promise.all([second, audition]);
    expect(spoken).toEqual(['system-default']);
  });

  it('auditions with the saved configuration and never saves unsaved edits', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    let playbackCount = 0;
    const sent: unknown[] = [];
    context.put = async (_path: string, patch: unknown) => {
      sent.push(plain(patch));
      return structuredClone(settings);
    };
    context.speak = async () => {
      ++playbackCount;
      return { ok: true, errors: [] };
    };
    evaluate(
      context,
      'state.settings = settingsFixture; Api.put = put; window.awm.speakTest = speak; toast = () => {}; routeDrafts("settings").set("setting-voice-voiceProfile", { value: "Meijia", checked: false, revision: 1 })',
    );
    evaluate(context, 'stagePatch(buildPatch("voice.voiceProfile", "Meijia"))');
    await evaluate<Promise<void>>(context, 'auditionVoice("synthetic test")');
    // 试听使用上次保存的音色，不触发保存、也不清掉未保存的修改。
    expect(playbackCount).toBe(1);
    expect(sent).toEqual([]);
    expect(evaluate<string>(context, 'state.settings.voice.voiceProfile')).toBe('system-default');
    expect(evaluate(context, 'hasPendingChanges()')).toBe(true);
    expect(
      evaluate<string>(context, 'routeDrafts("settings").get("setting-voice-voiceProfile").value'),
    ).toBe('Meijia');
  });
});

describe('renderer pending settings', () => {
  /** 让 Api.put 记录请求体并按 section 合并，模拟设置仓库的返回值。 */
  const saveHarness = (recordName: string): string => `
    Api.put = async (_url, patch) => {
      ${recordName}(patch);
      const next = JSON.parse(JSON.stringify(state.settings));
      for (const [section, fields] of Object.entries(patch))
        next[section] = { ...next[section], ...fields };
      return next;
    };`;

  it('normalizes range paths into one pending entry', () => {
    const context = renderer();
    expect(evaluate(context, 'pendingPathFor("quiet.ranges.1.to")')).toBe('quiet.ranges');
    expect(evaluate(context, 'pendingPathFor("quiet.from")')).toBe('quiet.ranges');
    // 只归并时段；其他同名字段各自独立。
    expect(evaluate(context, 'pendingPathFor("quiet.globalMute")')).toBe('quiet.globalMute');
    expect(evaluate(context, 'pendingPathFor("voice.rate")')).toBe('voice.rate');
  });

  it('collects only real differences and drops edits reverted to the saved value', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(
      context,
      `state.settings = settingsFixture;
      stagePatch(buildPatch("voice.rate", 1.5));
      stagePatch(buildPatch("quiet.ranges.0.from", "21:00"));`,
    );
    expect(
      plain(evaluate(context, 'collectPendingPatch(state.settings, pendingSettings, pendingPaths)')),
    ).toEqual({
      voice: { rate: 1.5 },
      quiet: {
        ranges: [
          { from: '21:00', to: '08:30' },
          { from: '12:00', to: '13:00' },
        ],
      },
    });
    expect(evaluate(context, 'pendingChangeCount()')).toBe(2);
    evaluate(
      context,
      `stagePatch(buildPatch("voice.rate", 1));
      stagePatch(buildPatch("quiet.ranges.0.from", "22:30"));`,
    );
    // 改回原值后不再算作待保存，也不会写进请求体。
    expect(
      plain(evaluate(context, 'collectPendingPatch(state.settings, pendingSettings, pendingPaths)')),
    ).toEqual({});
    expect(evaluate(context, 'hasPendingChanges()')).toBe(false);
  });

  it('merges edits from several sections into one save request', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const sent: unknown[] = [];
    context.record = (patch: unknown): void => {
      sent.push(plain(patch));
    };
    evaluate(
      context,
      `state.settings = settingsFixture; toast = () => {};
      ${saveHarness('record')}
      routeDrafts('settings').set('setting-voice-rate', { value: '1.5', checked: false, revision: 3 });
      stagePatch(buildPatch('voice.rate', 1.5));
      stagePatch(buildPatch('privacy.auditLog', false));
      stagePatch(buildPatch('quiet.globalMute', true));`,
    );
    expect(evaluate(context, 'pendingChangeCount()')).toBe(3);
    expect(await evaluate<Promise<boolean>>(context, 'savePendingSettings()')).toBe(true);
    expect(sent).toEqual([
      { voice: { rate: 1.5 }, privacy: { auditLog: false }, quiet: { globalMute: true } },
    ]);
    expect(evaluate(context, 'state.settings.voice.rate')).toBe(1.5);
    expect(evaluate(context, 'hasPendingChanges()')).toBe(false);
    expect(evaluate(context, 'pendingSettings')).toBe(null);
    expect(evaluate(context, 'routeDrafts("settings").has("setting-voice-rate")')).toBe(false);
  });

  it('rebases pending fields on newer server settings and follows the rest', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const next = structuredClone(settings);
    next.voice.volume = 0.5;
    next.quiet.globalMute = true;
    context.nextFixture = next;
    evaluate(
      context,
      `state.settings = settingsFixture;
      stagePatch(buildPatch('voice.rate', 1.5));
      rebasePendingSettings(nextFixture);`,
    );
    // 改动保留在预览里，未触碰的字段跟随服务端最新值。
    expect(evaluate(context, 'workingSettings().voice.rate')).toBe(1.5);
    expect(evaluate(context, 'workingSettings().voice.volume')).toBe(0.5);
    expect(evaluate(context, 'workingSettings().quiet.globalMute')).toBe(true);
    expect(evaluate(context, 'state.settings.voice.rate')).toBe(1);
    expect(evaluate(context, 'pendingChangeCount()')).toBe(1);
  });

  it('never stages a blank key and omits the key from unrelated saves', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.settingsFixture.voice.cloudApiKey = 'sk-saved';
    const sent: unknown[] = [];
    context.record = (patch: unknown): void => {
      sent.push(plain(patch));
    };
    evaluate(context, `state.settings = settingsFixture; toast = () => {}; ${saveHarness('record')}`);
    // 留空的密钥输入不产生待保存项，也不会覆盖已保存的 Key。
    expect(evaluate(context, 'stagePatch(buildPatch("voice.cloudApiKey", "   "))')).toBe(false);
    expect(evaluate(context, 'hasPendingChanges()')).toBe(false);
    evaluate(context, 'stagePatch(buildPatch("voice.rate", 1.25))');
    expect(await evaluate<Promise<boolean>>(context, 'savePendingSettings()')).toBe(true);
    expect(sent[0]).toEqual({ voice: { rate: 1.25 } });
    // 只有显式「清除」才把空串写进请求体。
    evaluate(context, 'stagePatch({ voice: { cloudApiKey: "" } })');
    expect(await evaluate<Promise<boolean>>(context, 'savePendingSettings()')).toBe(true);
    expect(sent[1]).toEqual({ voice: { cloudApiKey: '' } });
  });

  it('stacks consecutive quiet edits and keeps added ranges on save', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const sent: unknown[] = [];
    context.record = (patch: unknown): void => {
      sent.push(plain(patch));
    };
    evaluate(
      context,
      `state.settings = settingsFixture; toast = () => {};
      ${saveHarness('record')}
      const addRange = { quiet: { ranges: [...workingSettings().quiet.ranges, { from: '22:30', to: '08:30' }] } };
      stagePatch(addRange);
      stagePatch({ quiet: { ranges: [...workingSettings().quiet.ranges, { from: '22:30', to: '08:30' }] } });
      stagePatch(buildPatch('quiet.ranges.2.from', '23:15'));`,
    );
    expect(plain(evaluate(context, 'workingSettings().quiet.ranges'))).toEqual([
      { from: '22:30', to: '08:30' },
      { from: '12:00', to: '13:00' },
      { from: '23:15', to: '08:30' },
      { from: '22:30', to: '08:30' },
    ]);
    // 多条时段编辑仍只算一项待保存，保存时提交完整数组。
    expect(evaluate(context, 'pendingChangeCount()')).toBe(1);
    expect(await evaluate<Promise<boolean>>(context, 'savePendingSettings()')).toBe(true);
    expect(sent).toEqual([
      {
        quiet: {
          ranges: [
            { from: '22:30', to: '08:30' },
            { from: '12:00', to: '13:00' },
            { from: '23:15', to: '08:30' },
            { from: '22:30', to: '08:30' },
          ],
        },
      },
    ]);
  });

  it('stages rule changes, replays them on save, and drops reverted rules', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.rulesFixture = [
      { ruleId: 'event:task.failed', scopeTool: null, scopeEvent: 'task.failed', action: 'notify' },
    ];
    const calls: unknown[] = [];
    context.record = (value: unknown): void => {
      calls.push(plain(value));
    };
    evaluate(
      context,
      `state.settings = settingsFixture; state.rules = rulesFixture; toast = () => {};
      Api.put = async (_url, patch) => { record({ put: patch }); return state.settings; };
      Api.post = async (_url, body) => { record({ post: body }); return {}; };`,
    );
    evaluate(context, 'stageRule("task.failed", "speak")');
    // 规则也只暂存：页面先按预览显示，不发 POST。
    expect(calls).toEqual([]);
    expect(evaluate(context, 'pendingChangeCount()')).toBe(1);
    expect(
      evaluate(context, 'previewRules().find(rule => rule.scopeEvent === "task.failed").action'),
    ).toBe('speak');
    evaluate(context, 'stageRule("task.failed", "notify")');
    expect(evaluate(context, 'pendingChangeCount()')).toBe(0);
    expect(evaluate(context, 'previewRules().find(rule => rule.scopeEvent === "task.failed").action')).toBe(
      'notify',
    );
    evaluate(context, 'stageRule("task.failed", "speak")');
    expect(await evaluate<Promise<boolean>>(context, 'savePendingSettings()')).toBe(true);
    // 没有设置改动时只补发规则，不额外 PUT。
    expect(calls).toEqual([{ post: { scopeEvent: 'task.failed', action: 'speak' } }]);
    expect(
      evaluate(context, 'state.rules.find(rule => rule.scopeEvent === "task.failed").action'),
    ).toBe('speak');
    expect(evaluate(context, 'hasPendingChanges()')).toBe(false);
  });

  it('drops staged fields, rules and setting drafts when the edits are discarded', () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    context.rulesFixture = [
      { ruleId: 'event:task.failed', scopeTool: null, scopeEvent: 'task.failed', action: 'notify' },
    ];
    evaluate(
      context,
      `state.settings = settingsFixture; state.rules = rulesFixture;
      const draft = (value) => ({ value, checked: false, revision: 1 });
      routeDrafts('settings').set('setting-voice-rate', draft('1.5'));
      routeDrafts('settings').set('rule-task.failed', draft('speak'));
      routeDrafts('settings').set('audition-text', draft('测试播报'));
      state.sectionErrors.settings = 'synthetic failure';
      stagePatch(buildPatch('voice.rate', 1.5));
      stageRule('task.failed', 'speak');
      discardPendingSettings();`,
    );
    expect(evaluate(context, 'pendingSettings')).toBe(null);
    expect(evaluate(context, 'workingSettings().voice.rate')).toBe(1);
    expect(evaluate(context, 'hasPendingChanges()')).toBe(false);
    // 设置与规则草稿清掉；试听文本等纯界面输入保留。
    expect(evaluate(context, 'routeDrafts("settings").has("setting-voice-rate")')).toBe(false);
    expect(evaluate(context, 'routeDrafts("settings").has("rule-task.failed")')).toBe(false);
    expect(evaluate(context, 'routeDrafts("settings").has("audition-text")')).toBe(true);
    expect(evaluate(context, 'state.sectionErrors.settings')).toBe(undefined);
  });

  it('keeps the user on settings when the leave prompt is cancelled', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(
      context,
      `state.settings = settingsFixture; window.location.hash = '#/settings';
      stagePatch(buildPatch('voice.rate', 1.5));
      openConfirm = () => Promise.resolve('cancel');`,
    );
    await evaluate<Promise<void>>(context, 'requestLeaveSettings("#/overview")');
    expect(evaluate(context, 'window.location.hash')).toBe('#/settings');
    expect(evaluate(context, 'hasPendingChanges()')).toBe(true);
  });

  it('discards pending edits before navigating away', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    evaluate(
      context,
      `state.settings = settingsFixture; window.location.hash = '#/settings';
      stagePatch(buildPatch('voice.rate', 1.5));
      openConfirm = () => Promise.resolve('discard');`,
    );
    await evaluate<Promise<void>>(context, 'requestLeaveSettings("#/overview")');
    expect(evaluate(context, 'window.location.hash')).toBe('#/overview');
    expect(evaluate(context, 'hasPendingChanges()')).toBe(false);
    expect(evaluate(context, 'state.settings.voice.rate')).toBe(1);
  });

  it('lets the close proceed immediately when nothing is pending', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const replies: unknown[] = [];
    context.record = (value: unknown): void => {
      replies.push(plain(value));
    };
    evaluate(
      context,
      `state.settings = settingsFixture; state.route = 'settings';
      window.awm = {
        respondClose: (requestId, proceed) => record({ requestId, proceed }),
        showWindow: async () => record({ shown: true }),
      };`,
    );
    await evaluate(context, 'handleConfirmClose({ requestId: 7, reason: "close" })');
    expect(replies).toEqual([{ requestId: 7, proceed: true }]);
  });

  it('saves before quitting and blocks the quit when saving fails', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const calls: unknown[] = [];
    context.record = (value: unknown): void => {
      calls.push(plain(value));
    };
    evaluate(
      context,
      `state.settings = settingsFixture; state.route = 'settings'; toast = () => {};
      window.awm = {
        respondClose: (requestId, proceed) => record({ requestId, proceed }),
        showWindow: async () => record({ shown: true }),
      };
      ${saveHarness('record')}
      stagePatch(buildPatch('voice.rate', 1.5));
      openConfirm = () => Promise.resolve('save');`,
    );
    await evaluate(context, 'handleConfirmClose({ requestId: 8, reason: "quit" })');
    // 退出时先显示隐藏窗口，保存落盘后才允许退出。
    expect(calls).toEqual([
      { shown: true },
      { voice: { rate: 1.5 } },
      { requestId: 8, proceed: true },
    ]);
    expect(evaluate(context, 'hasPendingChanges()')).toBe(false);

    // 保存失败：不放行，修改保留，用户可返回设置页处理。
    calls.length = 0;
    evaluate(
      context,
      `stagePatch(buildPatch('voice.rate', 1.75));
      Api.put = async () => { throw new Error('synthetic save failure'); };`,
    );
    await evaluate(context, 'handleConfirmClose({ requestId: 9, reason: "quit" })');
    expect(calls).toEqual([
      { shown: true },
      { requestId: 9, proceed: false },
    ]);
    expect(evaluate(context, 'hasPendingChanges()')).toBe(true);
    expect(evaluate(context, 'state.sectionErrors.settings')).toContain('synthetic save failure');
  });

  it('blocks the close when the user cancels the prompt', async () => {
    const context = renderer();
    context.settingsFixture = structuredClone(settings);
    const replies: unknown[] = [];
    context.record = (value: unknown): void => {
      replies.push(plain(value));
    };
    evaluate(
      context,
      `state.settings = settingsFixture; state.route = 'settings';
      window.awm = {
        respondClose: (requestId, proceed) => record({ requestId, proceed }),
        showWindow: async () => record({ shown: true }),
      };
      toast = () => {};
      stagePatch(buildPatch('voice.rate', 1.5));
      openConfirm = () => Promise.resolve('cancel');`,
    );
    await evaluate(context, 'handleConfirmClose({ requestId: 10, reason: "close" })');
    expect(replies).toEqual([{ requestId: 10, proceed: false }]);
    expect(evaluate(context, 'hasPendingChanges()')).toBe(true);
  });
});

describe('renderer request order', () => {
  /** Synthetic clock and stream: no timers, sockets, or application data. */
  function refreshFixture(route = 'overview') {
    const context = renderer();
    const requests: string[] = [];
    const delays: number[] = [];
    let emit = (_type: string, _data: unknown): void => {};
    context.clock = 0;
    context.get = async (requestPath: string) => {
      requests.push(requestPath);
      if (requestPath.startsWith('/api/v1/board?')) return { groups: [], generatedAt: 'synthetic' };
      if (requestPath === '/api/v1/settings') return structuredClone(settings);
      if (requestPath === '/api/v1/voice/voices') return { voices: [] };
      return [];
    };
    context.subscribe = (_ticket: string, callback: typeof emit) => {
      emit = callback;
      return { close() {} };
    };
    context.schedule = (_callback: () => void, delay: number) => {
      delays.push(delay);
      return delays.length;
    };
    context.routeFixture = route;
    evaluate(
      context,
      `state.route = routeFixture; window.location.hash = '#/' + routeFixture;
      Date.now = () => clock; window.setTimeout = schedule; Api.get = get;
      Api.createStreamTicket = async () => 'synthetic-ticket';
      Api.stream = subscribe; toast = () => {}; connectStream();`,
    );
    return { context, requests, delays, emit: (type: string) => emit(type, {}) };
  }

  it('coalesces 25 overview events within one minute and reuses stable settings/tools', async () => {
    const f = refreshFixture();
    await evaluate(f.context, 'refresh()');
    expect(f.requests).toHaveLength(5);
    for (let index = 1; index <= 25; index += 1) {
      f.context.clock = index * 2_300;
      evaluate(f.context, 'refreshTimer = null');
      f.emit('state.transition');
      f.emit('board.updated');
      await evaluate(f.context, 'refresh(true)');
    }
    expect(f.requests.length).toBeLessThan(40);
    expect(f.requests.filter((url) => url === '/api/v1/settings')).toHaveLength(1);
    expect(f.requests.filter((url) => url === '/api/v1/tools')).toHaveLength(1);
    expect(f.requests.filter((url) => url.startsWith('/api/v1/board?')).length).toBeGreaterThan(3);
    expect(f.delays.some((delay) => delay >= 5_000)).toBe(true);
    // 用户主动刷新立即读取，不受后台间隔与缓存限制。
    const before = f.requests.length;
    await evaluate(f.context, 'refresh()');
    expect(f.requests.length - before).toBe(5);
  });

  it('refreshes settings changes locally, preserving drafts and ignoring board-only events', async () => {
    const f = refreshFixture('settings');
    await evaluate(f.context, 'refresh()');
    f.requests.length = 0;
    evaluate(f.context, 'stagePatch(buildPatch("voice.rate", 1.5))');
    f.context.clock = 15_000;
    f.emit('settings.changed');
    await evaluate(f.context, 'refresh(true)');
    expect(f.requests).toEqual(['/api/v1/settings', '/api/v1/voice/rules']);
    expect(evaluate(f.context, 'workingSettings().voice.rate')).toBe(1.5);
    expect(evaluate(f.context, 'state.settings.voice.rate')).toBe(1);
    f.requests.length = 0;
    f.context.clock = 25_000;
    f.emit('board.updated');
    await evaluate(f.context, 'refresh(true)');
    expect(f.requests).toHaveLength(0);
  });

  it('retains invalidations received during an in-flight refresh and retries failed sections', async () => {
    const f = refreshFixture();
    await evaluate(f.context, 'refresh()');
    let release: (value: unknown) => void = () => {};
    let failTools = true;
    f.context.get = async (requestPath: string) => {
      f.requests.push(requestPath);
      if (requestPath.startsWith('/api/v1/board?'))
        return new Promise((resolve) => {
          release = resolve;
        });
      if (requestPath === '/api/v1/tools' && failTools) throw new Error('synthetic tools failure');
      return [];
    };
    evaluate(f.context, 'Api.get = get');
    f.context.clock = 10_000;
    f.emit('state.transition');
    f.emit('tools.updated');
    const pending = evaluate<Promise<void>>(f.context, 'refresh(true)');
    f.emit('board.updated');
    const during = f.requests.length;
    await evaluate(f.context, 'refresh(true)');
    expect(f.requests).toHaveLength(during);
    release({ groups: [], generatedAt: 'first' });
    await pending;
    expect(evaluate(f.context, 'state.sectionErrors.tools')).toContain('synthetic tools failure');
    f.requests.length = 0;
    failTools = false;
    f.context.clock = 25_000;
    const retry = evaluate<Promise<void>>(f.context, 'refresh(true)');
    release({ groups: [], generatedAt: 'second' });
    await retry;
    expect(f.requests).toContain('/api/v1/board?limit=8');
    expect(f.requests).toContain('/api/v1/tools');
    expect(evaluate(f.context, 'state.sectionErrors.tools')).toBeUndefined();
  });

  it('discards previous-route responses without hiding successful settings sections', async () => {
    const context = renderer();
    const pending: Array<{ path: string; resolve: (value: unknown) => void }> = [];
    context.get = (requestPath: string) =>
      new Promise((resolve) => pending.push({ path: requestPath, resolve }));
    evaluate(context, 'Api.get = get');
    const old = evaluate<Promise<void>>(context, 'refresh()');
    const oldRequests = pending.splice(0);
    evaluate(context, 'window.location.hash = "#/settings"');
    const current = evaluate<Promise<void>>(context, 'refresh()');
    const currentRequests = pending.splice(0);
    for (const request of currentRequests)
      request.resolve(
        request.path === '/api/v1/settings'
          ? structuredClone(settings)
          : request.path === '/api/v1/voice/voices'
            ? { voices: [] }
            : [],
      );
    await current;
    for (const request of oldRequests)
      request.resolve(
        request.path === '/api/v1/settings'
          ? { ...structuredClone(settings), voice: { ...settings.voice, rate: 2 } }
          : { stale: true },
      );
    await old;
    expect(evaluate<string>(context, 'state.route')).toBe('settings');
    expect(evaluate<number>(context, 'state.settings.voice.rate')).toBe(1);
    expect(evaluate(context, 'state.overview')).toBeNull();
  });

  it('keeps the later drawer selection when an earlier response arrives last', async () => {
    const context = renderer();
    const body = { innerHTML: '', querySelector: () => null };
    const drawer = { hidden: true, querySelector: () => ({ focus() {} }) };
    const nodes: Record<string, unknown> = {
      '#drawer': drawer,
      '#drawer-body': body,
      '#drawer-title': { textContent: '' },
      '#drawer-subtitle': { textContent: '' },
      '#app': { inert: false },
    };
    const pending: Array<(value: unknown) => void> = [];
    context.nodes = nodes;
    context.get = () => new Promise((resolve) => pending.push(resolve));
    evaluate(
      context,
      'qs = (selector) => nodes[selector]; Api.get = get; renderTimeline = (records) => records[0].eventId',
    );
    const first = evaluate<Promise<void>>(context, 'openTimeline("first")');
    const second = evaluate<Promise<void>>(context, 'openTimeline("second")');
    pending[1]([{ eventId: 'second-response' }]);
    await second;
    pending[0]([{ eventId: 'first-response' }]);
    await first;
    expect(body.innerHTML).toBe('second-response');
    expect(evaluate(context, 'activeSessionId')).toBe('second');
  });
});
