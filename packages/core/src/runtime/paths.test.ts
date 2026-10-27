import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDataDir, runtimeFilePath } from './paths';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.unstubAllEnvs();
});

describe('品牌更名后的数据与桥接兼容', () => {
  it.each([
    {
      platform: 'darwin',
      expected: path.join(homedir(), 'Library', 'Application Support', 'AI Workflow Monitor'),
    },
    {
      platform: 'win32',
      appData: path.join(homedir(), 'fixture-roaming'),
      expected: path.join(homedir(), 'fixture-roaming', 'AI Workflow Monitor'),
    },
    {
      platform: 'win32',
      expected: path.join(homedir(), 'AppData', 'Roaming', 'AI Workflow Monitor'),
    },
    {
      platform: 'linux',
      xdg: path.join(homedir(), 'fixture-config'),
      expected: path.join(homedir(), 'fixture-config', 'AI Workflow Monitor'),
    },
    {
      platform: 'linux',
      expected: path.join(homedir(), '.config', 'AI Workflow Monitor'),
    },
  ])('在 $platform 上保留既有数据与默认握手路径（$expected）', (fixture) => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: fixture.platform });
    vi.stubEnv('APPDATA', fixture.appData);
    vi.stubEnv('XDG_CONFIG_HOME', fixture.xdg);

    expect(defaultDataDir()).toBe(fixture.expected);
    expect(runtimeFilePath()).toBe(path.join(fixture.expected, 'runtime.json'));
  });
});
