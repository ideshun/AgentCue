import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeSpeak = vi.hoisted(() => vi.fn(async () => undefined));
const localSpeak = vi.hoisted(() => vi.fn(async () => undefined));
const sherpaOptions = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@awm/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@awm/core')>();
  return {
    ...actual,
    createNativeBackend: () => ({
      name: 'native',
      isAvailable: () => true,
      speak: nativeSpeak,
    }),
  };
});

vi.mock('../../apps/desktop/src/main/sherpa-tts', () => ({
  createSherpaBackend: (options: unknown) => {
    sherpaOptions.current = options;
    return {
      name: 'local',
      isAvailable: () => true,
      speak: localSpeak,
    };
  },
}));

import { defaultSettings } from '@awm/schema';
import { createTtsChain } from '../../apps/desktop/src/main/tts-chain';

const options = { kokoroModelDir: '/synthetic/kokoro', zipvoiceModelDir: '/synthetic/zipvoice' };

describe('createTtsChain', () => {
  beforeEach(() => {
    nativeSpeak.mockClear();
    localSpeak.mockReset();
    localSpeak.mockResolvedValue(undefined);
    sherpaOptions.current = null;
  });

  it('Kokoro 播放失败时返回错误，不改播系统音色', async () => {
    const settings = defaultSettings();
    settings.voice.backend = 'local';
    settings.voice.voiceProfile = 'kokoro:3';
    localSpeak.mockRejectedValueOnce(new Error('合成测试错误'));

    const result = await createTtsChain(settings, options).speak({
      text: '合成测试文本',
      voiceProfile: settings.voice.voiceProfile,
    });

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('usedBackend');
    expect(result.errors.join('；')).toContain('合成测试错误');
    expect(localSpeak).toHaveBeenCalledWith(
      expect.objectContaining({ text: '合成测试文本', voiceProfile: 'kokoro:3' }),
      expect.any(AbortSignal),
    );
    expect(nativeSpeak).not.toHaveBeenCalled();
  });

  it('试听成功时使用所选 Kokoro 发音人', async () => {
    const settings = defaultSettings();
    settings.voice.backend = 'local';
    settings.voice.voiceProfile = 'kokoro:19';

    const result = await createTtsChain(settings, options).speak({
      text: '合成测试文本',
      voiceProfile: settings.voice.voiceProfile,
    });

    expect(result).toMatchObject({ ok: true, usedBackend: 'local' });
    expect(localSpeak).toHaveBeenCalledWith(
      expect.objectContaining({ text: '合成测试文本', voiceProfile: 'kokoro:19' }),
      expect.any(AbortSignal),
    );
    expect(nativeSpeak).not.toHaveBeenCalled();
  });

  it('ZipVoice 使用独立模型目录与参考录音，不复用 Kokoro 音色编号', async () => {
    const settings = defaultSettings();
    settings.voice.backend = 'local';
    settings.voice.localEngine = 'zipvoice';
    settings.voice.voiceProfile = 'kokoro:19';
    settings.voice.zipvoiceReferencePath = '/synthetic/reference.wav';
    settings.voice.zipvoiceReferenceText = '这是一段参考录音。';

    const result = await createTtsChain(settings, options).speak({
      text: '合成测试文本',
      voiceProfile: settings.voice.voiceProfile,
    });

    expect(result).toMatchObject({ ok: true, usedBackend: 'local' });
    expect(sherpaOptions.current).toMatchObject({
      engine: 'zipvoice',
      modelDir: '/synthetic/zipvoice',
      zipvoice: {
        referenceAudioPath: '/synthetic/reference.wav',
        referenceText: '这是一段参考录音。',
      },
    });
    expect(nativeSpeak).not.toHaveBeenCalled();
  });

  it('历史 Piper 配置保持不可用，不改播系统音色', async () => {
    const settings = defaultSettings();
    settings.voice.backend = 'piper';

    const result = await createTtsChain(settings, options).speak({ text: '合成测试文本' });

    expect(result.ok).toBe(false);
    expect(result.errors.join('；')).toContain('Piper');
    expect(localSpeak).not.toHaveBeenCalled();
    expect(nativeSpeak).not.toHaveBeenCalled();
  });
});
