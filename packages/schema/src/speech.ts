/** 播报摘要经过路径缩短后保留的最大 Unicode 字符数。 */
export const SPEECH_TITLE_MAX = 60;

/** @description: 将显式 @ 文件/目录引用缩为末段；不改普通斜杠文本、邮箱或 URL。 */
export function compactSpeechReferences(text: string): string {
  return text.replace(
    /(^|[^-A-Za-z0-9._%+])@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s<>"'“”‘’()[\]{}（）【】,，;；!?！？*]+))/g,
    (
      match,
      prefix: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) => {
      const reference = doubleQuoted ?? singleQuoted ?? bare;
      if (!reference || !/[\\/]/.test(reference) || /^https?:\/\//i.test(reference)) return match;
      const parts = reference.split(/[\\/]+/).filter(Boolean);
      const name = parts.at(-1);
      return name && name !== '.' && name !== '..' ? `${prefix}${name}` : match;
    },
  );
}
