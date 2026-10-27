/**
 * 设置 Schema 契约测试。
 * 覆盖：默认值填充、时段格式、枚举收敛。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLOUD_ENDPOINT, defaultSettings, settingsSchema } from './settings';

describe('settingsSchema', () => {
  it('默认值符合详细设计 5.8', () => {
    const settings = defaultSettings();
    expect(settings.schemaVersion).toBe(1);
    expect(settings.scan.autoIntervalHours).toBe(6);
    expect(settings.voice.enabled).toBe(true);
    expect(settings.voice.volume).toBe(0.8);
    expect(settings.quiet.ranges).toEqual([{ from: '22:30', to: '08:30' }]);
    expect(settings.quiet.waitingHumanOverride).toBe(true);
    expect(settings.privacy.scanScope).toBe('minimal');
    expect(settings.privacy.auditLog).toBe(true);
    expect(settings.scan.customTools).toEqual([]);
    expect(settings.voice.cloudEnabled).toBe(false);
    expect(settings.voice.savedVoices).toEqual([]);
  });

  it('云 TTS 默认填入可编辑的官方接口地址', () => {
    // 默认值必须是真实地址，设置页才能显示并可一键恢复，而不是只靠 placeholder。
    expect(defaultSettings().voice.cloudEndpoint).toBe(DEFAULT_CLOUD_ENDPOINT);
    // 旧版本存下的空串仍然合法，由设置仓库在读取时补成默认地址。
    expect(
      settingsSchema.parse({ schemaVersion: 1, voice: { cloudEndpoint: '' } }).voice.cloudEndpoint,
    ).toBe('');
  });

  it('仅提供 schemaVersion 时全部字段走默认值', () => {
    const parsed = settingsSchema.parse({ schemaVersion: 1 });
    expect(parsed.voice.backend).toBe('native');
    // 旧版本存下的 mcp 分区无任何消费方，读取时直接剥离。
    const legacy = settingsSchema.parse({
      schemaVersion: 1,
      mcp: { serverEnabled: true, transport: ['stdio'], port: 47831 },
    });
    expect('mcp' in legacy).toBe(false);
  });

  it('拒绝非法时段格式', () => {
    const result = settingsSchema.safeParse({
      schemaVersion: 1,
      quiet: {
        globalMute: false,
        ranges: [{ from: '22:30:00', to: '08:30' }],
        waitingHumanOverride: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it('拒绝超出范围的音量', () => {
    const result = settingsSchema.safeParse({
      schemaVersion: 1,
      voice: {
        enabled: true,
        volume: 1.5,
        rate: 1,
        voiceProfile: 'system-default',
        backend: 'native',
      },
    });
    expect(result.success).toBe(false);
  });

  it('接受新增 local 后端，旧 piper 与缺省值继续通过', () => {
    for (const backend of ['local', 'piper', 'native']) {
      const parsed = settingsSchema.parse({
        schemaVersion: 1,
        voice: {
          enabled: true,
          volume: 0.8,
          rate: 1,
          voiceProfile: 'kokoro:zf_001',
          backend,
        },
      });
      expect(parsed.voice.backend).toBe(backend);
      expect(parsed.voice.voiceProfile).toBe('kokoro:zf_001');
    }
    expect(
      settingsSchema.safeParse({ schemaVersion: 1, voice: { backend: 'kokoro' } }).success,
    ).toBe(false);
  });

  it('保存常用音色名称，拒绝重复音色与空名称', () => {
    const voices = [{ profile: 'kokoro:3', name: '  清晰女声  ' }];
    const parsed = settingsSchema.parse({ schemaVersion: 1, voice: { savedVoices: voices } });
    expect(parsed.voice.savedVoices).toEqual([{ profile: 'kokoro:3', name: '清晰女声' }]);
    for (const savedVoices of [[...voices, ...voices], [{ profile: 'kokoro:3', name: ' ' }]]) {
      expect(settingsSchema.safeParse({ schemaVersion: 1, voice: { savedVoices } }).success).toBe(
        false,
      );
    }
  });
});
