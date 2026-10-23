import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildKokoroPronunciationLexicon } from '../../apps/desktop/src/main/kokoro-pronunciation';

// 合成词典仅用于验证音素组合与优先级，不读取用户模型或实际播放音频。
const lexicon =
  '崇 ch ong 2\n重 zh ong 4\n构 g ou 4\n试 sh i 4\n新 x in 1\n启 q i 3\n置 zh i 4\n复 f u 4\n建 j ian 4\n连 l ian 2\n重构 zh ong 4 g ou 4\n';

const mocks = vi.hoisted(() => ({
  createAsync: vi.fn(),
  generateAsync: vi.fn(),
  readWave: vi.fn(),
  writeWave: vi.fn(),
  playAudioFile: vi.fn(),
}));

vi.mock('sherpa-onnx-node', () => ({
  GenerationConfig: class {
    constructor(options: Record<string, unknown>) {
      Object.assign(this, options);
    }
  },
  OfflineTts: { createAsync: mocks.createAsync },
  readWave: mocks.readWave,
  writeWave: mocks.writeWave,
}));

vi.mock('@awm/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@awm/core')>()),
  playAudioFile: mocks.playAudioFile,
}));

describe('Sherpa Kokoro backend', () => {
  let modelDir = '';

  beforeEach(async () => {
    modelDir = await mkdtemp(path.join(tmpdir(), 'awm-kokoro-test-'));
    await writeFile(path.join(modelDir, 'lexicon-zh.txt'), lexicon);
    mocks.createAsync.mockReset();
    mocks.generateAsync.mockReset();
    mocks.playAudioFile.mockReset();
    mocks.createAsync.mockResolvedValue({
      numSpeakers: 103,
      sampleRate: 24_000,
      generateAsync: mocks.generateAsync,
    });
    mocks.generateAsync.mockResolvedValue({
      samples: new Float32Array([0.1, -0.1]),
      sampleRate: 24_000,
    });
    mocks.writeWave.mockReset();
    mocks.playAudioFile.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(modelDir, { recursive: true, force: true });
  });

  it('uses a JS-owned audio buffer and the selected Chinese speaker for audition', async () => {
    const { createSherpaBackend } = await import('../../apps/desktop/src/main/sherpa-tts');
    const backend = createSherpaBackend({ modelDir });

    await backend.speak({
      text: '这是 Kokoro 中文试听。',
      voiceProfile: 'kokoro:3',
      rate: 1,
      volume: 0.8,
    });

    expect(mocks.generateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '这是 Kokoro 中文试听。',
        enableExternalBuffer: false,
        generationConfig: expect.objectContaining({ sid: 3, speed: 1 }),
      }),
    );
    expect(mocks.playAudioFile).toHaveBeenCalledOnce();
  });

  it('loads corrected phrase pronunciations before the original dictionary and keeps the spoken text', async () => {
    let overrideFile = '';
    mocks.createAsync.mockImplementation(async (config) => {
      const files = config.model.kokoro.lexicon.split(',');
      overrideFile = files[0];
      expect(files.slice(1)).toEqual([
        path.join(modelDir, 'lexicon-us-en.txt'),
        path.join(modelDir, 'lexicon-zh.txt'),
      ]);
      expect(await readFile(overrideFile, 'utf8')).toContain('重构 ch ong 2 g ou 4\n');
      return { numSpeakers: 103, sampleRate: 24_000, generateAsync: mocks.generateAsync };
    });
    const { createSherpaBackend } = await import('../../apps/desktop/src/main/sherpa-tts');
    await createSherpaBackend({ modelDir }).speak({ text: '重构登录模块，重要任务已完成' });
    expect(mocks.generateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ text: '重构登录模块，重要任务已完成' }),
    );
    await expect(readFile(overrideFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(modelDir, 'lexicon-zh.txt'), 'utf8')).toBe(lexicon);
  });
});

describe('Sherpa ZipVoice backend', () => {
  let modelDir = '';
  let referenceFile = '';

  beforeEach(async () => {
    modelDir = await mkdtemp(path.join(tmpdir(), 'awm-zipvoice-test-'));
    referenceFile = path.join(modelDir, 'reference.wav');
    await writeFile(referenceFile, 'RIFF');
    mocks.createAsync.mockReset();
    mocks.generateAsync.mockReset();
    mocks.readWave.mockReset();
    mocks.writeWave.mockReset();
    mocks.playAudioFile.mockReset();
    mocks.createAsync.mockResolvedValue({
      numSpeakers: 0,
      sampleRate: 24_000,
      generateAsync: mocks.generateAsync,
    });
    mocks.generateAsync.mockResolvedValue({
      samples: new Float32Array([0.1, -0.1]),
      sampleRate: 24_000,
    });
    mocks.readWave.mockReturnValue({
      samples: new Float32Array([0.25, -0.25]),
      sampleRate: 16_000,
    });
    mocks.playAudioFile.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(modelDir, { recursive: true, force: true });
  });

  it('uses the reference recording and transcript instead of a preset speaker id', async () => {
    const { createSherpaBackend } = await import('../../apps/desktop/src/main/sherpa-tts');
    const backend = createSherpaBackend({
      modelDir,
      engine: 'zipvoice',
      zipvoice: { referenceAudioPath: referenceFile, referenceText: '这是一段参考录音。' },
    });

    await backend.speak({
      text: '构建完成。',
      voiceProfile: 'kokoro:3',
      rate: 1.2,
      volume: 0.8,
    });

    expect(mocks.createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          zipvoice: {
            encoder: path.join(modelDir, 'encoder.int8.onnx'),
            decoder: path.join(modelDir, 'decoder.int8.onnx'),
            vocoder: path.join(modelDir, 'vocos_24khz.onnx'),
            tokens: path.join(modelDir, 'tokens.txt'),
            lexicon: [
              path.join(modelDir, 'lexicon.txt'),
              path.join(modelDir, 'lexicon-en-us.txt'),
            ].join(','),
          },
        }),
      }),
    );
    const generation = mocks.generateAsync.mock.calls[0][0].generationConfig;
    expect(generation).toMatchObject({
      speed: 1.2,
      numSteps: 4,
      referenceText: '这是一段参考录音。',
      referenceSampleRate: 16_000,
      extra: { min_char_in_sentence: '10' },
    });
    // ZipVoice 没有 sid；Kokoro 的音色编号不得泄漏进参考音频合成。
    expect(generation).not.toHaveProperty('sid');
    expect(Array.from(generation.referenceAudio)).toEqual([0.25, -0.25]);
    expect(mocks.readWave).toHaveBeenCalledWith(referenceFile);
    expect(mocks.playAudioFile).toHaveBeenCalledOnce();
  });

  it('requires both a reference recording and its transcript before loading the model', async () => {
    const { createSherpaBackend } = await import('../../apps/desktop/src/main/sherpa-tts');
    await expect(
      createSherpaBackend({
        modelDir,
        engine: 'zipvoice',
        zipvoice: { referenceAudioPath: '', referenceText: '录音原文' },
      }).speak({ text: '测试' }),
    ).rejects.toThrow('ZipVoice 需要参考音频');
    await expect(
      createSherpaBackend({
        modelDir,
        engine: 'zipvoice',
        zipvoice: { referenceAudioPath: referenceFile, referenceText: '' },
      }).speak({ text: '测试' }),
    ).rejects.toThrow('逐字对应');
    expect(mocks.createAsync).not.toHaveBeenCalled();
    expect(mocks.generateAsync).not.toHaveBeenCalled();
  });
});

describe('Kokoro Chinese pronunciation', () => {
  it('corrects whole development terms without globally changing polyphonic characters', () => {
    const corrected = buildKokoroPronunciationLexicon(lexicon);
    expect(corrected).toContain('重构 ch ong 2 g ou 4\n');
    expect(corrected).toContain('重试 ch ong 2 sh i 4\n');
    expect(corrected).toContain('重新 ch ong 2 x in 1\n');
    expect(corrected).not.toMatch(/^重\s/m);
    expect(corrected).not.toContain('重要');
    expect(corrected).not.toContain('zh ong 4');
  });

  it('covers the expanded development phrases the base dictionary lacks', () => {
    // 重写／重命名是扩展清单里的新词：三字词要逐字借音，缺词必须被生成。
    const corrected = buildKokoroPronunciationLexicon(
      lexicon + '写 sh xie 3\n命 sh ming 4\n名 sh ming 2\n做 z zuo 4\n',
    );
    expect(corrected).toContain('重写 ch ong 2 sh xie 3\n');
    expect(corrected).toContain('重命名 ch ong 2 sh ming 4 sh ming 2\n');
    expect(corrected).toContain('重做 ch ong 2 z zuo 4\n');
  });

  it('skips phrases whose suffix is missing instead of failing the whole build', () => {
    // 后缀字缺失只跳过该词：模型词典缺字不该让所有本地播报启动失败。
    const corrected = buildKokoroPronunciationLexicon(lexicon);
    expect(corrected).toContain('重构 ch ong 2 g ou 4\n');
    expect(corrected).not.toContain('重写');
  });

  it('reports an incomplete model dictionary instead of silently skipping the correction', () => {
    expect(() => buildKokoroPronunciationLexicon('构 g ou 4')).toThrow('chóng');
  });
});
