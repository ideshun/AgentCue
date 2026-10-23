/** 按当前选择装配 TTS 后端；播放失败由调用方呈现错误，不静默换成其他音色。 */
import {
  TtsChain,
  createCloudBackend,
  createNativeBackend,
  createPiperBackend,
} from '@awm/core';
import type { Settings } from '@awm/schema';
import { createSherpaBackend } from './sherpa-tts';

export interface TtsChainOptions {
  /** Kokoro 模型目录。 */
  kokoroModelDir: string;
  /** ZipVoice 模型目录。 */
  zipvoiceModelDir: string;
}

/** @description: 试听和自动播报都尊重所选后端；后端失败时交给 VoiceService 通知并保留诊断。 */
export function createTtsChain(settings: Settings, options: TtsChainOptions): TtsChain {
  const native = createNativeBackend();
  if (settings.voice.backend === 'cloud') {
    return new TtsChain([
      createCloudBackend({
        enabled: settings.voice.cloudEnabled,
        endpoint: settings.voice.cloudEndpoint,
        apiKey: settings.voice.cloudApiKey,
        model: settings.voice.cloudModel,
        voice: settings.voice.cloudVoice,
      }),
    ]);
  }
  if (settings.voice.backend === 'piper') {
    // 历史值保持为不可用；不得把 Kokoro 音色编号交给系统语音程序。
    return new TtsChain([createPiperBackend()]);
  }
  if (settings.voice.backend === 'local') {
    const zipvoice = settings.voice.localEngine === 'zipvoice';
    return new TtsChain([
      createSherpaBackend({
        engine: zipvoice ? 'zipvoice' : 'kokoro',
        modelDir: zipvoice ? options.zipvoiceModelDir : options.kokoroModelDir,
        zipvoice: {
          referenceAudioPath: settings.voice.zipvoiceReferencePath,
          referenceText: settings.voice.zipvoiceReferenceText,
        },
      }),
    ]);
  }
  return new TtsChain([native]);
}
