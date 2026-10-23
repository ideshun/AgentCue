/**
 * 适配器 manifest 加载器（SM-1.1）。
 * 解析 YAML → Zod 校验，任一字段非法都需指明具体字段与文件。
 */
import { adapterManifestSchema, type AdapterManifest } from '@awm/schema';
import { parse } from 'yaml';

/** manifest 加载失败的错误，带文件路径信息 */
export class ManifestLoadError extends Error {
  /** 出错文件路径 */
  public readonly sourcePath: string;

  /** 具体出错字段（可为空） */
  public readonly fields: string[];

  /**
   * @param sourcePath 出错文件路径
   * @param message 错误描述
   * @param fields 出错字段路径列表
   */
  constructor(sourcePath: string, message: string, fields: string[] = []) {
    super(`适配器 manifest 加载失败（${sourcePath}）：${message}`);
    this.name = 'ManifestLoadError';
    this.sourcePath = sourcePath;
    this.fields = fields;
  }
}

/**
 * 从文本加载并校验 manifest。
 * @param text YAML 文本
 * @param sourcePath 文件路径，用于错误提示
 * @returns 校验通过的 manifest
 * @throws YAML 解析或字段校验失败时抛出 ManifestLoadError
 */
export function loadManifestFromText(text: string, sourcePath: string): AdapterManifest {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ManifestLoadError(sourcePath, `YAML 解析失败：${message}`);
  }

  const result = adapterManifestSchema.safeParse(raw);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.'));
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`)
      .join('；');
    throw new ManifestLoadError(sourcePath, message, fields);
  }
  return result.data;
}
