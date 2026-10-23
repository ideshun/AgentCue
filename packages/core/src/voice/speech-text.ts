/**
 * 播报文本归一化：把状态文案里合成器容易读错的写法换成口语读法。
 *
 * 只处理确定性强、与引擎无关的形态：时间、百分比、版本号、容量/耗时单位。
 * 不做英文音译（品牌名与缩写交给引擎按原文读），也不改动看板与通知原文。
 */

/** 单位读法：只在数字紧邻时替换，避免误伤普通英文单词。 */
const UNIT_READINGS: Readonly<Record<string, string>> = {
  TB: '太字节',
  GB: '吉字节',
  MB: '兆字节',
  KB: '千字节',
  ms: '毫秒',
  s: '秒',
};

/**
 * @description: 归一化播报文本。幂等：已归一化的文本再次处理不会继续变化。
 * @param text 模板渲染后的播报文本
 * @returns 适合直接交给 TTS 的文本
 */
export function normalizeForSpeech(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim();
  // 时间：12:30 → 12 点 30 分；先处理，避免后面的冒号规则重复匹配。
  out = out.replace(/(^|[^\d:])(\d{1,2}):(\d{2})(?![\d:])/g, '$1$2 点 $3 分');
  // 百分比：45% → 百分之 45。
  out = out.replace(/(\d+(?:\.\d+)?)\s*%/g, '百分之 $1');
  // 版本号：v1.2.3 → 版本 1.2.3；点号交给中文引擎读成“点”。
  out = out.replace(/(^|\s)[vV](\d+(?:\.\d+)+)(?![\w.])/g, '$1版本 $2');
  // 容量与耗时：1.5GB → 1.5 吉字节，300ms → 300 毫秒。
  out = out.replace(
    /(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|ms|s)(?![a-zA-Z])/g,
    (_match, amount: string, unit: string) => `${amount} ${UNIT_READINGS[unit] ?? unit}`,
  );
  return out;
}
