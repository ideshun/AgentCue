/**
 * 三层探测器与编排器单测。
 * 进程探测涉及真实系统调用，此处只断言纯逻辑与降级行为。
 */
import { describe, expect, it } from 'vitest';
import type { AdapterManifest } from '@awm/schema';
import { detectConfigPath, expandPath, matchProcessLine, mergeDetectStatus } from './detector';
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

describe('matchProcessLine', () => {
  // 夹具用中性进程名：core 源码（含测试）不得出现任何具体工具名（契约 no-tool-name）。
  const psOutput = [
    '  501 /Applications/ProbeApp.app/Contents/MacOS/ProbeApp --type=renderer',
    '  502 agentcli exec --task demo',
    '  503 tail -f /Users/me/agentcli-notes.log',
    '  504 /opt/homebrew/bin/watchtool --continue',
    '',
  ].join('\n');

  it('按 command 首 token 精确命中进程名', () => {
    expect(matchProcessLine(psOutput, 'agentcli', false)).toBe('  502 agentcli exec --task demo');
    expect(matchProcessLine(psOutput, 'ProbeApp', false)).toContain('ProbeApp.app');
    expect(matchProcessLine(psOutput, 'watchtool', false)).toContain('homebrew/bin/watchtool');
  });

  it('参数或路径中的子串不误报 running', () => {
    expect(matchProcessLine(psOutput, 'agentcli-notes', false)).toBeNull();
    expect(matchProcessLine('  999 tail -f ~/agentcli/trace\n', 'agentcli', false)).toBeNull();
    expect(matchProcessLine(psOutput, 'agent', false)).toBeNull();
  });

  it('tasklist 按映像名命中（含 .exe 变体）', () => {
    const csv = '"ProbeAgent.EXE","1234","Console","1","10,240 K"\n"explorer.exe","99","Console","1","5,120 K"';
    expect(matchProcessLine(csv, 'probeagent', true)).toContain('ProbeAgent.EXE');
    expect(matchProcessLine(csv, 'explorer', true)).toContain('explorer.exe');
    expect(matchProcessLine(csv, 'probe', true)).toBeNull();
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
