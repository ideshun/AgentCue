/** Route handlers run against in-memory HTTP streams; no listening sockets or user data. */
import { mkdtempSync, rmSync } from 'node:fs';
import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { normalizeCursorHook } from '@awm/adapters';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMigrations,
  getSession,
  listEvents,
  MIGRATIONS,
  tables,
  upsertTool,
} from '@awm/store';
import { startApiServer, type ApiServerHandle } from '../../apps/desktop/src/main/api-server';
import { Engine } from '../../apps/desktop/src/main/engine-host';
import { DesktopFacade } from '../../apps/desktop/src/main/facade';
import { SettingsStore } from '../../apps/desktop/src/main/settings-store';
import {
  listStdioMcpTools,
  listHttpMcpTools,
  type McpConnectResult,
} from '../../apps/desktop/src/main/mcp-client';

vi.mock('../../apps/desktop/src/main/mcp-client', () => ({
  listStdioMcpTools: vi.fn(),
  listHttpMcpTools: vi.fn(),
}));

let root: string;
let engine: Engine;
let facade: DesktopFacade;
let settings: SettingsStore;
let api: ApiServerHandle;
const TOKEN = 'synthetic-api-test-token';

function validation(error: string | null = null): McpConnectResult {
  return {
    ok: error === null,
    status: 'disconnected',
    validationStatus: error === null ? 'verified' : 'error',
    tools: error === null ? [{ name: 'fixture_tool' }] : [],
    lastValidatedAt: '2026-10-20T12:00:00.000Z',
    lastError: error,
  };
}

beforeEach(async () => {
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
    this: Server,
    ...args: unknown[]
  ) {
    const callback = args.at(-1);
    if (typeof callback === 'function') queueMicrotask(() => callback());
    return this;
  });
  vi.spyOn(Server.prototype, 'address').mockReturnValue({
    address: '127.0.0.1',
    family: 'IPv4',
    port: 47831,
  });
  vi.mocked(listStdioMcpTools).mockResolvedValue(validation());
  vi.mocked(listHttpMcpTools).mockResolvedValue(validation());
  root = mkdtempSync(path.join(tmpdir(), 'awm-api-fixture-'));
  engine = new Engine(root);
  settings = new SettingsStore(path.join(root, 'settings.json'));
  facade = new DesktopFacade(engine, undefined, {
    getSettings: () => settings.get(),
    updateSettings: (patch) => settings.update(patch),
  });
  upsertTool(engine.database, {
    toolId: 'fixture-agent',
    name: 'Fixture',
    adapterId: 'fixture-agent',
    detectStatus: 'installed',
  });
  api = await startApiServer({
    port: 0,
    token: TOKEN,
    engine,
    facade,
    getSettings: () => settings.get(),
    updateSettings: (patch) => settings.update(patch),
    getAdapters: () => [],
    triggerScan: async () => 'synthetic-scan',
    speakTest: async () => ({ ok: true, usedBackend: 'native', errors: [] }),
    getNativeVoices: async () => ({
      voices: [{ id: 'Tingting (Fixture)', name: 'Tingting (Fixture)', language: 'zh_CN' }],
    }),
    getMcpLaunch: () => ({ command: '/fixture/app', args: ['--mcp-stdio'], commandReady: true }),
  });
});

afterEach(async () => {
  await api?.close();
  await engine?.stop();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

interface ApiResult {
  status: number;
  body: { success?: boolean; data?: unknown; error?: { code: string; message: string } };
}

function request(
  url: string,
  method = 'GET',
  body?: unknown,
  authenticated = true,
): Promise<ApiResult> {
  const stream = Readable.from(
    body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))],
  );
  Object.assign(stream, {
    url,
    method,
    headers: authenticated ? { authorization: `Bearer ${TOKEN}` } : {},
  });
  return new Promise((resolve, reject) => {
    let status = 200;
    const timer = setTimeout(
      () => reject(new Error(`Route did not finish: ${method} ${url}`)),
      1000,
    );
    const response = {
      setHeader: () => undefined,
      writeHead: (value: number) => {
        status = value;
      },
      end: (data?: string | Buffer) => {
        clearTimeout(timer);
        try {
          resolve({ status, body: data ? (JSON.parse(data.toString()) as ApiResult['body']) : {} });
        } catch (error) {
          reject(error);
        }
      },
    };
    api.server.emit('request', stream as IncomingMessage, response as unknown as ServerResponse);
  });
}

function session(id: string, state: 'running' | 'waiting_human' | 'completed'): void {
  engine.database
    .insert(tables.sessions)
    .values({
      sessionId: id,
      toolId: 'fixture-agent',
      title: id,
      currentState: state,
      updatedAt: new Date().toISOString(),
    })
    .run();
}

function cursorHook(phase: 'beforeSubmitPrompt' | 'stop') {
  const event = normalizeCursorHook({
    hook_event_name: phase,
    conversation_id: 'synthetic-conversation',
    generation_id: 'synthetic-turn',
    ...(phase === 'beforeSubmitPrompt' ? { prompt: '合成登录任务' } : { status: 'completed' }),
  })[0]!;
  return { mode: 'turn', event };
}

describe('official hook ingestion API', () => {
  it('requires authentication before accepting task events', async () => {
    expect(
      await request('/api/v1/integrations/hooks', 'POST', cursorHook('beforeSubmitPrompt'), false),
    ).toMatchObject({ status: 401 });
    expect(listEvents(engine.database)).toHaveLength(0);
  });

  it('accepts start and completion exactly once and exposes observed receipt time', async () => {
    const transitions = vi.fn();
    engine.onTransition = transitions;
    const before = await request('/api/v1/integrations/hooks');
    expect(before.status).toBe(200);
    expect(
      (before.body.data as Array<{ lastEventAt: string | null }>).every(
        (item) => item.lastEventAt === null,
      ),
    ).toBe(true);
    const start = cursorHook('beforeSubmitPrompt');
    expect(await request('/api/v1/integrations/hooks', 'POST', start)).toMatchObject({
      status: 200,
      body: { data: { accepted: true } },
    });
    expect(await request('/api/v1/integrations/hooks', 'POST', start)).toMatchObject({
      status: 200,
      body: { data: { accepted: false } },
    });
    const end = cursorHook('stop');
    expect(await request('/api/v1/integrations/hooks', 'POST', end)).toMatchObject({
      status: 200,
      body: { data: { accepted: true } },
    });
    expect(await request('/api/v1/integrations/hooks', 'POST', end)).toMatchObject({
      status: 200,
      body: { data: { accepted: false } },
    });
    expect(getSession(engine.database, start.event.sessionId)).toMatchObject({
      currentState: 'completed',
      title: '合成登录任务',
    });
    expect(transitions).toHaveBeenCalledTimes(2);
    expect(transitions.mock.calls.map(([result]) => result.eventType)).toEqual([
      'task.started',
      'task.completed',
    ]);
    expect(listEvents(engine.database)).toHaveLength(2);
    const after = await request('/api/v1/integrations/hooks');
    expect(
      (after.body.data as Array<{ id: string; lastEventAt: string | null }>).find(
        (item) => item.id === 'cursor',
      )?.lastEventAt,
    ).toBeTruthy();
    expect((await facade.listTools()).find((item) => item.toolId === 'cursor')).toMatchObject({
      sessionCapability: 'events',
    });
  });

  it.each(['privacy', 'ignored'] as const)(
    'does not write hooks while %s disables the source',
    async (reason) => {
      if (reason === 'privacy') settings.update({ privacy: { sessionFileRead: false } });
      else settings.update({ scan: { ignoredToolIds: ['cursor'] } });
      expect(
        await request('/api/v1/integrations/hooks', 'POST', cursorHook('beforeSubmitPrompt')),
      ).toMatchObject({ status: 200, body: { data: { accepted: false, reason: 'disabled' } } });
      expect(listEvents(engine.database)).toHaveLength(0);
      const status = await request('/api/v1/integrations/hooks');
      expect(
        (status.body.data as Array<{ id: string; enabled: boolean }>).find(
          (item) => item.id === 'cursor',
        )?.enabled,
      ).toBe(false);
    },
  );

  it('rejects unverified phase, actor and source writes without changing the MCP state whitelist', async () => {
    const start = cursorHook('beforeSubmitPrompt');
    for (const patch of [
      { eventType: 'task.retried' },
      { toolId: 'unknown' },
      { actor: 'human' },
      { sessionId: 'not-a-hook' },
    ])
      expect(
        await request('/api/v1/integrations/hooks', 'POST', {
          ...start,
          event: { ...start.event, ...patch },
        }),
      ).toMatchObject({ status: 400 });
    expect(listEvents(engine.database)).toHaveLength(0);
  });
});

describe('desktop API exception boundaries', () => {
  it('returns 400 for a malformed request URL without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(await request('http://[', 'GET', undefined, false)).toMatchObject({
        status: 400,
        body: { success: false, error: { code: 'INVALID_PARAM' } },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects startup when the mocked listening socket emits an error', async () => {
    const failure = Object.assign(new Error('synthetic listen denied'), { code: 'EACCES' });
    vi.mocked(Server.prototype.listen).mockImplementationOnce(function (this: Server) {
      queueMicrotask(() => this.emit('error', failure));
      return this;
    });
    await expect(
      startApiServer({
        port: 0,
        token: TOKEN,
        engine,
        facade,
        getSettings: () => settings.get(),
        updateSettings: (patch) => settings.update(patch),
        getAdapters: () => [],
        triggerScan: async () => 'synthetic-scan',
        speakTest: async () => ({ ok: true, usedBackend: 'native', errors: [] }),
      }),
    ).rejects.toBe(failure);
  });
});

describe('desktop API state and settings validation', () => {
  it('lists installed voices behind authentication and persists a selected voice', async () => {
    expect(await request('/api/v1/voice/voices', 'GET', undefined, false)).toMatchObject({
      status: 401,
    });
    expect(await request('/api/v1/voice/voices')).toMatchObject({
      status: 200,
      body: { data: { voices: [{ id: 'Tingting (Fixture)', language: 'zh_CN' }] } },
    });
    expect(
      await request('/api/v1/settings', 'PUT', { voice: { voiceProfile: 'Tingting (Fixture)' } }),
    ).toMatchObject({ status: 200 });
    expect(settings.get().voice.voiceProfile).toBe('Tingting (Fixture)');
  });

  it('preserves custom speech text and priority when only a rule action changes', async () => {
    await request('/api/v1/voice/rules', 'POST', {
      scopeEvent: 'task.completed',
      action: 'notify',
      template: '完成了，{title}。',
      priority: 'high',
    });
    expect(
      await request('/api/v1/voice/rules', 'POST', {
        scopeEvent: 'task.completed',
        action: 'speak',
      }),
    ).toMatchObject({
      status: 200,
      body: { data: { action: 'speak', template: '完成了，{title}。', priority: 'high' } },
    });
  });

  it.each(['events', 'state'] as const)(
    'enforces the state whitelist on the %s endpoint',
    async (endpoint) => {
      session('running-fixture', 'running');
      const url =
        endpoint === 'events'
          ? '/api/v1/sessions/running-fixture/events'
          : '/api/v1/tasks/running-fixture/state';
      const response = await request(
        url,
        'POST',
        endpoint === 'events' ? { eventType: 'task.completed' } : { event: 'task.completed' },
      );
      expect(response).toMatchObject({
        status: 400,
        body: { success: false, error: { code: 'INVALID_PARAM' } },
      });
      expect(getSession(engine.database, 'running-fixture')?.currentState).toBe('running');
    },
  );

  it.each(['events', 'state'] as const)(
    'distinguishes illegal transitions and missing tasks on %s',
    async (endpoint) => {
      session('completed-fixture', 'completed');
      const url = (id: string) =>
        endpoint === 'events' ? `/api/v1/sessions/${id}/events` : `/api/v1/tasks/${id}/state`;
      const body =
        endpoint === 'events' ? { eventType: 'task.retried' } : { event: 'task.retried' };
      expect(await request(url('completed-fixture'), 'POST', body)).toMatchObject({
        status: 409,
        body: { error: { code: 'ILLEGAL_TRANSITION' } },
      });
      expect(await request(url('missing-fixture'), 'POST', body)).toMatchObject({
        status: 404,
        body: { error: { code: 'NOT_FOUND' } },
      });
    },
  );

  it('persists a valid numeric setting and rejects string values and malformed JSON with 400', async () => {
    expect(await request('/api/v1/settings', 'PUT', { voice: { rate: 1.3 } })).toMatchObject({
      status: 200,
      body: { success: true },
    });
    expect(settings.get().voice.rate).toBe(1.3);
    expect(await request('/api/v1/settings', 'PUT', { voice: { rate: '1.8' } })).toMatchObject({
      status: 400,
      body: { error: { code: 'INVALID_PARAM' } },
    });
    expect(await request('/api/v1/settings', 'PUT', '{')).toMatchObject({
      status: 400,
      body: { error: { code: 'INVALID_PARAM' } },
    });
    expect(settings.get().voice.rate).toBe(1.3);
  });

  it('rejects null and array request bodies without changing settings', async () => {
    const previous = settings.get();
    for (const body of [null, []]) {
      expect(await request('/api/v1/settings', 'PUT', body)).toMatchObject({
        status: 400,
        body: { success: false, error: { code: 'INVALID_PARAM' } },
      });
    }
    expect(settings.get()).toEqual(previous);
  });

  it('rejects non-boolean ignore values without silently unignoring a tool', async () => {
    settings.update({ scan: { ignoredToolIds: ['fixture-agent', 'another-fixture'] } });
    for (const body of [{ ignored: 'false' }, { ignored: 'true' }, {}]) {
      expect(await request('/api/v1/tools/fixture-agent/ignored', 'POST', body)).toMatchObject({
        status: 400,
        body: { success: false, error: { code: 'INVALID_PARAM' } },
      });
      expect(settings.get().scan.ignoredToolIds).toEqual(['fixture-agent', 'another-fixture']);
    }
  });

  it('validates board and session parameters and keeps authentication required', async () => {
    expect(await request('/api/v1/board?group=running&cursor=bad-cursor')).toMatchObject({
      status: 400,
      body: { error: { code: 'INVALID_PARAM' } },
    });
    expect(await request('/api/v1/sessions?limit=-1')).toMatchObject({ status: 400 });
    expect(await request('/api/v1/board', 'GET', undefined, false)).toMatchObject({ status: 401 });
  });

  it('returns actual audition and bundled MCP validation results', async () => {
    expect(
      await request('/api/v1/voice/test', 'POST', { text: 'synthetic preview' }),
    ).toMatchObject({ status: 200, body: { data: { ok: true, usedBackend: 'native' } } });
    expect(await request('/api/v1/mcp/validate', 'POST')).toMatchObject({
      status: 200,
      body: { data: { ok: true, status: 'disconnected', validationStatus: 'verified' } },
    });
    expect(listStdioMcpTools).toHaveBeenCalledWith('/fixture/app', ['--mcp-stdio']);
  });
});

describe('external MCP validation persistence', () => {
  it('migrates legacy connected rows to unverified disconnected records without losing their configuration', () => {
    const legacy = new Database(':memory:');
    try {
      for (const migration of MIGRATIONS.filter((item) => item.version <= 2))
        legacy.exec(migration.sql);
      legacy.pragma('user_version = 2');
      legacy
        .prepare(
          'INSERT INTO mcp_servers(server_id,name,transport,command,args,status,tools) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          'legacy',
          'Legacy fixture',
          'stdio',
          'fixture-command',
          '["--legacy"]',
          'connected',
          '[]',
        );
      applyMigrations(legacy);
      const row = legacy.prepare('SELECT * FROM mcp_servers WHERE server_id = ?').get('legacy');
      expect(row).toMatchObject({
        command: 'fixture-command',
        args: '["--legacy"]',
        status: 'disconnected',
        validation_status: 'unverified',
        last_validated_at: null,
        last_error: null,
      });
      expect(() => applyMigrations(legacy)).not.toThrow();
    } finally {
      legacy.close();
    }
  });

  it('stores successful verification separately from connection status and retains diagnostics on revalidation', async () => {
    const created = await request('/api/v1/mcp/servers', 'POST', {
      name: 'Fixture MCP',
      transport: 'stdio',
      command: 'fixture-command',
      args: ['--fixture'],
    });
    expect(created).toMatchObject({
      status: 200,
      body: {
        data: {
          status: 'disconnected',
          validationStatus: 'verified',
          lastValidatedAt: '2026-10-20T12:00:00.000Z',
          lastError: null,
        },
      },
    });
    const createdRow = created.body.data as { serverId: string; args: string; tools: string };
    expect(JSON.parse(createdRow.args)).toEqual(['--fixture']);
    expect(JSON.parse(createdRow.tools)).toEqual([{ name: 'fixture_tool' }]);
    vi.mocked(listStdioMcpTools).mockResolvedValue(validation('fixture stopped'));
    await request('/api/v1/mcp/servers', 'POST', {
      serverId: createdRow.serverId,
      name: 'Fixture MCP',
      transport: 'stdio',
      command: 'fixture-command',
      args: ['--fixture'],
    });
    const stored = (await request('/api/v1/mcp/servers')).body.data;
    expect(stored).toMatchObject([
      {
        serverId: createdRow.serverId,
        status: 'disconnected',
        validationStatus: 'error',
        lastError: 'fixture stopped',
        tools: '[]',
      },
    ]);
  });

  it('rejects malformed configurations before attempting any process or network validation', async () => {
    expect(
      await request('/api/v1/mcp/servers', 'POST', {
        name: 'bad',
        transport: 'stdio',
        command: 'fixture',
        args: 'not-array',
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await request('/api/v1/mcp/servers', 'POST', {
        name: 'bad',
        transport: 'streamable-http',
        url: 'file:///fixture',
      }),
    ).toMatchObject({ status: 400 });
    expect(listStdioMcpTools).not.toHaveBeenCalled();
    expect(listHttpMcpTools).not.toHaveBeenCalled();
  });
});
