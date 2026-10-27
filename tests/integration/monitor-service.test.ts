/**
 * 监控服务集成测试（FLOW-01 + FLOW-02 串起来）。
 *
 * 覆盖：
 * - manifest 加载与三层探测落库
 * - 会话文件增量读取、事件归一并补全起始事件
 * - 重复扫描不重复投递
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '@awm/schema';
import { listAudit, listEvents, listSessions, listTools } from '@awm/store';
import { createStandardEvent } from '@awm/core';
import { Engine } from '../../apps/desktop/src/main/engine-host';
import { MonitorService } from '../../apps/desktop/src/main/monitor-service';

/** 测试临时根目录 */
let root = '';

/** 引擎 */
let engine: Engine | null = null;

/** 监控服务 */
let monitor: MonitorService | null = null;

/** 数据目录 */
let dataDir = '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'awm-monitor-'));
  dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  const adapterDir = path.join(root, 'adapters');
  mkdirSync(adapterDir, { recursive: true });

  const configPath = path.join(root, 'demo-config.json');
  writeFileSync(configPath, '{"enabled":true}');
  const configPlatform =
    process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

  const sessionDir = path.join(root, 'sessions', 'proj-a');
  mkdirSync(sessionDir, { recursive: true });

  const now = Date.now();
  const lines = [
    JSON.stringify({
      type: 'user',
      timestamp: new Date(now - 180_000).toISOString(),
      message: { role: 'user', content: '重构登录模块' },
    }),
    JSON.stringify({
      type: 'permission_request',
      timestamp: new Date(now - 120_000).toISOString(),
      toolName: 'Bash',
    }),
  ];
  writeFileSync(path.join(sessionDir, 'sess-1.jsonl'), `${lines.join('\n')}\n`);

  writeFileSync(
    path.join(adapterDir, 'demo.manifest.yaml'),
    [
      'id: demo-tool',
      'name: Demo Tool',
      'detect:',
      '  configPaths:',
      `    - ${configPlatform}: ${JSON.stringify(configPath)}`,
      '  processNames: ["awm-demo-not-running"]',
      '  apis: []',
      'sessionSource:',
      '  type: jsonl',
      `  pathPattern: ${JSON.stringify(`${path.join(root, 'sessions')}/**/*.jsonl`)}`,
      'eventMapping:',
      '  waiting_human: { match: "permission_request", reason: "tool_approval" }',
      '  completed: { match: "result", ok: true }',
      '  failed: { match: "result", ok: false }',
      'heartbeat: { intervalSec: 30, probe: "file_mtime" }',
      'mcp: { clientConfigFormat: "generic" }',
      '',
    ].join('\n'),
  );

  engine = new Engine(dataDir);
  monitor = new MonitorService({
    db: engine.database,
    engine,
    getSettings: () => defaultSettings(),
    resourcesDir: adapterDir,
  });
});

afterEach(async () => {
  monitor?.stop();
  await engine?.stop();
  engine = null;
  monitor = null;
  rmSync(root, { recursive: true, force: true });
});

describe('MonitorService', () => {
  it('扫描后写入工具记录并建立会话', async () => {
    const summary = await monitor?.scan();
    await engine?.stop();

    expect(summary?.ingestedEvents).toBe(1);
    const tools = listTools(engine!.database);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolId).toBe('demo-tool');
    expect(tools[0]?.detectStatus).toBe('installed');

    const sessions = listSessions(engine!.database, { limit: 10 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('demo-tool:proj-a:sess-1');
    expect(sessions[0]?.title).toBe('重构登录模块');
    expect(sessions[0]?.currentState).toBe('waiting_human');
  });

  it('会话文件未变化时不重复投递事件', async () => {
    await monitor?.scan();
    const second = await monitor?.scan();
    expect(second?.ingestedEvents).toBe(0);
  });

  it('适配器 manifest 非法时只降级该适配器，不中断扫描', async () => {
    writeFileSync(path.join(root, 'adapters', 'broken.manifest.yaml'), 'id: BAD ID\nname: x\n');
    const broken = new MonitorService({
      db: engine!.database,
      engine: engine!,
      getSettings: () => defaultSettings(),
      resourcesDir: path.join(root, 'adapters'),
    });
    expect(broken.loadErrors.length).toBeGreaterThan(0);
    expect(broken.adapters).toHaveLength(1);
    broken.stop();
  });
});

describe('Engine 事件路径', () => {
  it('非迁移类事件（anomaly）只落库不推进状态', async () => {
    // 先扫描建立会话（waiting_human），排空总线后再注入 anomaly
    await monitor?.scan();
    await engine?.stop();

    engine!.ingest(
      createStandardEvent({
        sessionId: 'demo-tool:proj-a:sess-1',
        toolId: 'demo-tool',
        eventType: 'anomaly',
        actor: 'system',
        payload: { reason: '原始信号无法归一' },
      }),
    );
    await engine!.stop();

    const events = listEvents(engine!.database, { eventType: 'anomaly' });
    expect(events).toHaveLength(1);
    expect(events[0]?.nextState).toBeNull();
    // 会话状态不被 anomaly 影响
    const sessions = listSessions(engine!.database, { limit: 10 });
    expect(sessions[0]?.currentState).toBe('waiting_human');
  });

  it('非法迁移被拒绝且记入审计日志', async () => {
    await monitor?.scan();
    await engine?.stop();

    // waiting_human --human.responded--> running --task.completed--> completed
    engine!.ingest(
      createStandardEvent({
        sessionId: 'demo-tool:proj-a:sess-1',
        toolId: 'demo-tool',
        eventType: 'human.responded',
      }),
    );
    engine!.ingest(
      createStandardEvent({
        sessionId: 'demo-tool:proj-a:sess-1',
        toolId: 'demo-tool',
        eventType: 'task.completed',
      }),
    );
    // completed 回跳 running：迁移表约束 4 明令禁止
    engine!.ingest(
      createStandardEvent({
        sessionId: 'demo-tool:proj-a:sess-1',
        toolId: 'demo-tool',
        eventType: 'task.started',
      }),
    );
    await engine!.stop();

    const audit = listAudit(engine!.database).filter(
      (row) => row.action === 'illegal.transition.rejected',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.result).toContain('completed 不接受 task.started');

    // 状态保持 completed，未被非法事件改写
    const sessions = listSessions(engine!.database, { limit: 10 });
    expect(sessions[0]?.currentState).toBe('completed');
  });
});
