/**
 * sherpa-onnx-node 无官方 TypeScript 声明，这里仅声明本项目用到的最小表面。
 * 形状与 node_modules/sherpa-onnx-node/{types.js,non-streaming-tts.js} 逐一核对（v1.13.8）。
 */
declare module 'sherpa-onnx-node' {
  export interface GenerationConfigInit {
    sid?: number;
    speed?: number;
    silenceScale?: number;
  }

  export class GenerationConfig {
    constructor(init?: GenerationConfigInit);
  }

  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface ProgressInfo {
    samples: Float32Array;
    progress: number;
  }

  export interface GenerateRequest {
    text: string;
    sid?: number;
    speed?: number;
    generationConfig?: GenerationConfig;
    onProgress?: (info: ProgressInfo) => number | boolean | void;
  }

  export interface OfflineTtsConfig {
    model?: {
      kokoro?: {
        model?: string;
        voices?: string;
        tokens?: string;
        dataDir?: string;
        lengthScale?: number;
        lexicon?: string;
        lang?: string;
      };
      numThreads?: number;
      provider?: string;
    };
    /** 部分版本把 numThreads/provider 放在顶层，两种布局都接受，以实测为准 */
    numThreads?: number;
    provider?: string;
    maxNumSentences?: number;
    silenceScale?: number;
  }

  export class OfflineTts {
    constructor(config: OfflineTtsConfig);
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    readonly numSpeakers: number;
    readonly sampleRate: number;
    generate(request: GenerateRequest): GeneratedAudio;
    generateAsync(request: GenerateRequest): Promise<GeneratedAudio>;
  }

  export function writeWave(
    path: string,
    audio: { samples: Float32Array; sampleRate: number },
  ): void;
}
