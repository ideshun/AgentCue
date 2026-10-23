/**
 * 播报最短链（T-M0-05）：迁移信号 → 规则判定 → TTS 播报。
 * 去抖合并、优先级队列、免打扰属 FLOW-04 完整版，M1 在此之上叠加。
 */
import { resolveAction, type TransitionSignal, type VoiceRule } from './rule-engine';
import type { SpeakResult, TtsChain } from './tts';

/** 最短链执行结果 */
export interface AnnounceResult {
  /** 规则判定出的动作 */
  action: 'mute' | 'notify' | 'speak';
  /** 待播报文本，仅 speak 时存在 */
  text?: string;
  /** 播报结果，仅 speak 时存在 */
  speak?: SpeakResult;
}

/**
 * 执行一次播报编排：命中 mute/notify 直接返回，命中 speak 才调 TTS。
 * @param signal 迁移信号
 * @param rules 播报规则
 * @param chain TTS 降级链
 * @returns 编排结果
 */
export async function announce(
  signal: TransitionSignal,
  rules: VoiceRule[],
  chain: TtsChain,
): Promise<AnnounceResult> {
  const decision = resolveAction(rules, signal);
  if (decision.action !== 'speak') {
    return { action: decision.action };
  }
  const text = decision.text ?? '';
  const result = await chain.speak({ text });
  return { action: 'speak', text, speak: result };
}
