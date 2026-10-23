/**
 * 设置仓库：接口地址始终是可直接显示、可恢复的默认值。
 * 旧版本存成空串（表示“用官方地址”），或粘贴文档里的基础地址时，都补成实际请求的 URL。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CLOUD_ENDPOINT } from '@awm/schema';
import { SettingsStore } from '../../apps/desktop/src/main/settings-store';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

/** 用给定的 settings.json 内容建一个仓库实例 */
function storeWith(contents: unknown): { store: SettingsStore; file: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'awm-settings-'));
  directories.push(directory);
  const file = path.join(directory, 'settings.json');
  writeFileSync(file, JSON.stringify(contents), 'utf8');
  return { store: new SettingsStore(file), file };
}

describe('SettingsStore 云 TTS 接口地址', () => {
  it('把旧版空地址补成官方默认值，其余字段保持不变', () => {
    const { store } = storeWith({
      schemaVersion: 1,
      voice: { cloudEndpoint: '', rate: 1.25, cloudApiKey: 'sk-local' },
    });
    const settings = store.get();
    expect(settings.voice.cloudEndpoint).toBe(DEFAULT_CLOUD_ENDPOINT);
    expect(settings.voice.rate).toBe(1.25);
    expect(settings.voice.cloudApiKey).toBe('sk-local');
  });

  it('保留用户自定义的完整接口地址', () => {
    const { store } = storeWith({
      schemaVersion: 1,
      voice: { cloudEndpoint: 'https://tts.example.com/v1/audio' },
    });
    expect(store.get().voice.cloudEndpoint).toBe('https://tts.example.com/v1/audio');
  });

  it('把文档里的基础地址补成实际请求的地址', () => {
    // 直接 POST …/anthropic 或 …/v1 只会拿到网关 404。
    for (const endpoint of [
      'https://api.xiaomimimo.com/anthropic',
      'https://api.xiaomimimo.com/v1',
    ]) {
      const { store } = storeWith({ schemaVersion: 1, voice: { cloudEndpoint: endpoint } });
      expect(store.get().voice.cloudEndpoint).toBe(DEFAULT_CLOUD_ENDPOINT);
    }
  });

  it('读取时只补内存里的值，不主动改写用户的文件', () => {
    const { store, file } = storeWith({
      schemaVersion: 1,
      voice: { cloudEndpoint: 'https://api.xiaomimimo.com/v1' },
    });
    expect(store.get().voice.cloudEndpoint).toBe(DEFAULT_CLOUD_ENDPOINT);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      voice: { cloudEndpoint: string };
    };
    expect(saved.voice.cloudEndpoint).toBe('https://api.xiaomimimo.com/v1');
  });

  it('写入空地址或基础地址时落盘为完整地址', () => {
    for (const endpoint of ['', 'https://api.xiaomimimo.com/v1']) {
      const { store, file } = storeWith({ schemaVersion: 1 });
      const updated = store.update({ voice: { cloudEndpoint: endpoint } });
      expect(updated.voice.cloudEndpoint).toBe(DEFAULT_CLOUD_ENDPOINT);
      const saved = JSON.parse(readFileSync(file, 'utf8')) as {
        voice: { cloudEndpoint: string };
      };
      expect(saved.voice.cloudEndpoint).toBe(DEFAULT_CLOUD_ENDPOINT);
    }
  });
});
