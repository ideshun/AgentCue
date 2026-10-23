/** 只探测临时目录中的合成扩展清单，绝不读取用户扩展目录。 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterManifestSchema, type AdapterManifest } from '@awm/schema';
import { detectExtensions } from '@awm/core';

let temporary = '';
let root = '';
let manifest: AdapterManifest;

function install(folder: string, info: Record<string, unknown>): string {
  const dir = path.join(root, folder);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'package.json');
  writeFileSync(file, JSON.stringify(info));
  return file;
}

beforeEach(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'awm-extension-'));
  root = path.join(temporary, 'extensions');
  mkdirSync(root);
  manifest = adapterManifestSchema.parse({
    id: 'demo-extension',
    name: 'Demo Extension',
    detect: {
      extensions: [
        { id: 'publisher.agent', host: 'Editor', roots: [{ mac: root, win: root, linux: root }] },
      ],
    },
    sessionSource: { type: 'none' },
    eventMapping: {},
    heartbeat: { intervalSec: 60, probe: 'file_mtime' },
  });
});
afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

describe('detectExtensions', () => {
  it('通过 publisher.name 身份提取版本，选择最新有效目录', () => {
    install('publisher.agent-1.2.0', { publisher: 'publisher', name: 'agent', version: '1.2.0' });
    const latest = install('publisher.agent-1.12.0', {
      publisher: 'publisher',
      name: 'agent',
      version: '1.12.0',
    });
    expect(detectExtensions(manifest)).toEqual({
      configPath: latest,
      version: '1.12.0',
      host: 'Editor',
    });
  });

  it('身份和候选目录名大小写不敏感', () => {
    const file = install('Publisher.Agent-2.0.0', {
      publisher: 'PUBLISHER',
      name: 'Agent',
      version: '2.0.0',
    });
    expect(detectExtensions(manifest)?.configPath).toBe(file);
  });

  it('忽略无关目录、嵌套目录和伪装成匹配名字的清单', () => {
    install('unrelated.extension-9', { publisher: 'publisher', name: 'agent', version: '9' });
    install('nested/publisher.agent-10', { publisher: 'publisher', name: 'agent', version: '10' });
    install('publisher.agent-99', { publisher: 'different', name: 'agent', version: '99' });
    expect(detectExtensions(manifest)).toBeNull();
  });

  it('缺失根或没有声明扩展时返回null', () => {
    expect(
      detectExtensions({ ...manifest, detect: { ...manifest.detect, extensions: [] } }),
    ).toBeNull();
    const missing = path.join(temporary, 'missing');
    manifest.detect.extensions![0]!.roots = [{ mac: missing, win: missing, linux: missing }];
    expect(detectExtensions(manifest)).toBeNull();
  });

  it('候选目录symlink不能逃到声明根之外', () => {
    const outside = path.join(temporary, 'outside');
    mkdirSync(outside);
    writeFileSync(
      path.join(outside, 'package.json'),
      JSON.stringify({ publisher: 'publisher', name: 'agent', version: '9' }),
    );
    symlinkSync(outside, path.join(root, 'publisher.agent-9'), 'dir');
    expect(detectExtensions(manifest)).toBeNull();
  });

  it('package.json symlink同样不能读取声明根外的文件', () => {
    const outside = path.join(temporary, 'outside-package.json');
    writeFileSync(outside, JSON.stringify({ publisher: 'publisher', name: 'agent', version: '9' }));
    const candidate = path.join(root, 'publisher.agent-9');
    mkdirSync(candidate);
    symlinkSync(outside, path.join(candidate, 'package.json'), 'file');
    expect(detectExtensions(manifest)).toBeNull();
  });

  it('较新候选清单损坏不能遮蔽较旧的有效安装', () => {
    const good = install('publisher.agent-1.0.0', {
      publisher: 'publisher',
      name: 'agent',
      version: '1.0.0',
    });
    const broken = path.join(root, 'publisher.agent-9.0.0');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'package.json'), '{broken');
    expect(detectExtensions(manifest)?.configPath).toBe(good);
  });

  it('超过大小上限的候选清单被跳过', () => {
    const big = path.join(root, 'publisher.agent-9.0.0');
    mkdirSync(big);
    writeFileSync(path.join(big, 'package.json'), ' '.repeat(1024 * 1024 + 1));
    expect(detectExtensions(manifest)).toBeNull();
  });
});
