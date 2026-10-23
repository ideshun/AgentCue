/**
 * 三层探测器与编排器单测。
 * 进程探测涉及真实系统调用，此处只断言纯逻辑与降级行为。
 */
import { describe, expect, it } from 'vitest';
import type { AdapterManifest } from '@awm/schema';
import { detectConfigPath, expandPath, mergeDetectStatus } from './detector';
import { ScanOrchestrator } from './orchestrator';

/** 构造 manifest */
function manifest(id: string, overrides: Partial<AdapterManifest> = {}): AdapterManifest {
  return {
    id,
    name: id,
    detect: { configPaths: [], processNames: [], apis: [] },
    sessionSource: { type: 'jsonl', pathPattern: '~/.demo/**/*.jsonl' },
    eventMapping: { completed: { match: 'result', ok: true } },
    heartbeat: { intervalSec: 30, probe: 'file_mtime' },
    ...overrides,
  };
}

describe('expandPath', () => {
  it('展开 ~ 为家目录', () => {
    expect(expandPath('~/.demo')).toMatch(/^\//);
    expect(expandPath('~/.demo')).not.toContain('~');
  });

  it('未匹配的环境变量替换为空串', () => {
    expect(expandPath('/tmp/%NOT_SET_XYZ%/x')).toBe('/tmp//x');
  });
});

describe('detectConfigPath', () => {
  it('命中存在的路径', () => {
    expect(detectConfigPath(['/etc/hosts'])).toBe('/etc/hosts');
  });

  it('全部不存在时返回 null', () => {
    expect(detectConfigPath(['/definitely/not/exist/a', '/definitely/not/exist/b'])).toBeNull();
  });
});

describe('mergeDetectStatus', () => {
  it('进程运行中判定 running', () => {
    expect(mergeDetectStatus(true, true, false)).toBe('running');
  });

  it('API 可达判定 running', () => {
    expect(mergeDetectStatus(false, false, true)).toBe('running');
  });

  it('配置存在但进程缺失判定 installed', () => {
    expect(mergeDetectStatus(true, false, false)).toBe('installed');
  });

  it('配置与进程都缺失判定 not_installed', () => {
    expect(mergeDetectStatus(false, false, false)).toBe('not_installed');
  });
});

describe('ScanOrchestrator', () => {
  it('忽略清单内的适配器不参与扫描', async () => {
    const orchestrator = new ScanOrchestrator([manifest('a'), manifest('b')]);
    const report = await orchestrator.scan({ ignoredToolIds: ['a'] });
    expect(report.results.map((item) => item.toolId)).toEqual(['b']);
  });

  it('无配置无进程时判定 not_installed', async () => {
    const orchestrator = new ScanOrchestrator([manifest('demo-1')]);
    const report = await orchestrator.scan();
    expect(report.results[0]?.status).toBe('not_installed');
    expect(report.degraded).toHaveLength(0);
  });

  it('按并发上限分批且不漏结果', async () => {
    const orchestrator = new ScanOrchestrator([
      manifest('demo-1'),
      manifest('demo-2'),
      manifest('demo-3'),
      manifest('demo-4'),
      manifest('demo-5'),
    ]);
    const report = await orchestrator.scan({ concurrency: 2 });
    expect(report.results).toHaveLength(5);
    expect(report.startedAt).toBeTruthy();
    expect(report.finishedAt).toBeTruthy();
  });

  it('空注册表返回空结果', async () => {
    const orchestrator = new ScanOrchestrator([]);
    const report = await orchestrator.scan();
    expect(report.results).toHaveLength(0);
  });
});
