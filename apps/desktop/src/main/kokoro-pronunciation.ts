/**
 * 词级读音覆盖：借用模型内同音字的音素，保持原播报文本和模型 token 集不变。
 * 只收录开发语境里「重」必读 chóng 且无 zhòng 歧义的词；基础词典缺这些词时，
 * 单字「重」默认读 zhòng，会把整词读错（实测：重构以外的重写、重排等均读错）。
 * 有意排除有歧义的词：重载（zài/“过载”）、重用（zhòngyòng“委以重任”），交由原词典判断。
 */
const CHONG_PHRASES = [
  '重构',
  '重建',
  '重试',
  '重新',
  '重启',
  '重置',
  '重复',
  '重连',
  '重写',
  '重做',
  '重命名',
  '重播',
  '重放',
  '重排',
  '重组',
  '重整',
  '重测',
  '重跑',
  '重传',
  '重编译',
  '重定位',
  '重绘',
  '重现',
  '重申',
];

/** @description: 生成优先加载的短语词典，不改变“重要／重量”等其他语境中的“重”。 */
export function buildKokoroPronunciationLexicon(source: string): string {
  // flatMap 而不是 map：三字词（重命名、重编译）要拆成单字收集，否则后缀查不到会拒启动。
  const needed = new Set(['崇', '虫', ...CHONG_PHRASES.flatMap((phrase) => [...phrase.slice(1)])]);
  const entries = new Map<string, string[]>();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    const separator = trimmed.search(/\s/u);
    if (separator < 0) continue;
    const word = trimmed.slice(0, separator);
    if (!needed.has(word) || entries.has(word)) continue;
    const phones = trimmed.slice(separator).trim();
    if (phones) entries.set(word, phones.split(/\s+/u));
  }
  const chong = entries.get('崇') ?? entries.get('虫');
  if (!chong) throw new Error('Kokoro 中文词典缺少 chóng 的基础读音，请重新下载模型');
  // 后缀字缺失时只跳过该词：个别词典缺字不该让整套本地播报启动失败。
  return (
    CHONG_PHRASES.flatMap((phrase) => {
      const phones = [...chong];
      for (const character of phrase.slice(1)) {
        const suffix = entries.get(character);
        if (!suffix) return [];
        phones.push(...suffix);
      }
      return [`${phrase} ${phones.join(' ')}`];
    }).join('\n') + '\n'
  );
}
