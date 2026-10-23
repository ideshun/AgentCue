/**
 * 事件总线与扫描编排耗时粗测（C-04）。
 * 不启动 Electron，只验证内存路径明显低于预算。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { AdapterRegistry, loadManifestFromText } from '@awm/adapters';
import { ScanOrchestrator, SessionEventBus, createStandardEvent } from '@awm/core';

describe('latency-report', () => {
  it('200 条事件排空明显低于 3s 预算', async () => {
    const bus = new SessionEventBus(() => undefined);
    const start = performance.now();
    for (let index = 0; index < 200; index += 1) {
      bus.enqueue(
        createStandardEvent({
          sessionId: `demo:p:s${index % 20}`,
          toolId: 'demo-tool',
          eventType: 'task.started',
        }),
      );
    }
    await bus.idle();
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(3000);
  });

  it('三适配器扫描明显低于 5s 预算', async () => {
    const dir = path.resolve(process.cwd(), 'packages/adapters/resources/adapters');
    const registry = new AdapterRegistry();
    for (const name of ['claude-code.manifest.yaml', 'codex.manifest.yaml', 'cursor.manifest.yaml']) {
      const full = path.join(dir, name);
      registry.register(loadManifestFromText(readFileSync(full, 'utf8'), full));
    }
    const orchestrator = new ScanOrchestrator(registry.list());
    const start = performance.now();
    const report = await orchestrator.scan({ ignoredToolIds: [] });
    const ms = performance.now() - start;
    expect(report.results.length).toBe(3);
    expect(ms).toBeLessThan(5000);
  });
});
