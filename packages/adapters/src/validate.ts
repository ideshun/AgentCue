/**
 * 适配器 manifest 校验器（TODO-29）。
 * 只做静态校验：YAML + Zod + 探测路径声明完整性，不扫描用户磁盘。
 */
import { readFileSync } from 'node:fs';
import { adapterManifestSchema, type AdapterManifest } from '@awm/schema';
import { ManifestLoadError, loadManifestFromText } from './loader';

/** 单条校验问题 */
export interface AdapterValidationIssue {
  /** 字段路径 */
  path: string;
  /** 说明 */
  message: string;
}

/** 校验结果 */
export interface AdapterValidationResult {
  /** 是否通过 */
  ok: boolean;
  /** 源路径 */
  sourcePath: string;
  /** 通过时的 manifest */
  manifest?: AdapterManifest;
  /** 问题列表 */
  issues: AdapterValidationIssue[];
}

/**
 * 校验一份 YAML 文本。
 * @param text YAML
 * @param sourcePath 来源
 * @returns 校验结果
 */
export function validateManifestText(text: string, sourcePath: string): AdapterValidationResult {
  try {
    const manifest = loadManifestFromText(text, sourcePath);
    const issues: AdapterValidationIssue[] = [];
    if (manifest.detect.configPaths.length === 0 && manifest.detect.processNames.length === 0) {
      issues.push({
        path: 'detect',
        message: 'configPaths 与 processNames 都为空，扫描无法判定已安装',
      });
    }
    if (manifest.sessionSource.type === 'jsonl' && !manifest.sessionSource.pathPattern) {
      issues.push({ path: 'sessionSource.pathPattern', message: 'jsonl 类型必须声明 pathPattern' });
    }
    const parsed = adapterManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ path: issue.path.join('.') || '(根)', message: issue.message });
      }
    }
    return {
      ok: issues.length === 0,
      sourcePath,
      manifest,
      issues,
    };
  } catch (error) {
    if (error instanceof ManifestLoadError) {
      return {
        ok: false,
        sourcePath,
        issues: error.fields.length
          ? error.fields.map((field) => ({ path: field || '(根)', message: error.message }))
          : [{ path: '(根)', message: error.message }],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, sourcePath, issues: [{ path: '(根)', message }] };
  }
}

/**
 * 校验磁盘上的 manifest 文件。
 * @param filePath 文件路径
 * @returns 校验结果
 */
export function validateManifestFile(filePath: string): AdapterValidationResult {
  try {
    const text = readFileSync(filePath, 'utf8');
    return validateManifestText(text, filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, sourcePath: filePath, issues: [{ path: '(根)', message }] };
  }
}
