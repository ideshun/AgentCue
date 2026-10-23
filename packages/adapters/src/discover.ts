/**
 * 会话文件发现（SM-1.4 的输入侧）。
 *
 * manifest 的 `sessionSource.pathPattern` 只支持两种形态，够用且好测：
 * - `<base>/**\/*.jsonl`：递归查找
 * - `<base>/*.jsonl`：单层查找
 * 不做完整 glob 实现，避免引入 glob 依赖并带来符号链接逃逸风险。
 */
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';

/** 递归查找的最大深度，防止误配路径导致全盘遍历 */
const MAX_DEPTH = 6;

/** 会话文件发现选项 */
export interface DiscoverOptions {
  /** 返回条数上限，默认 200 */
  limit?: number;
  /** 递归深度上限，默认 6 */
  maxDepth?: number;
}

/**
 * 展开 `~` 与 Windows 风格环境变量。
 * 与 core 的 detector 保持同样的展开规则，但本包不依赖 core（依赖方向约束）。
 * @param raw 原始路径
 * @returns 展开后的路径
 */
export function expandPatternPath(raw: string): string {
  let value = raw;
  if (value.startsWith('~')) {
    value = path.join(homedir(), value.slice(1));
  }
  return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) => {
    return process.env[name] ?? '';
  });
}

/**
 * 把文件名通配符转为正则，仅支持 `*` 与 `?`。
 * @param glob 文件名模式
 * @returns 匹配用的正则
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`);
}

/**
 * 递归收集目录下的文件。
 * @param dir 目录
 * @param matcher 文件名匹配器
 * @param depth 当前深度
 * @param maxDepth 深度上限
 * @param out 收集结果
 */
function walk(dir: string, matcher: RegExp, depth: number, maxDepth: number, out: string[]): void {
  if (depth > maxDepth) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 无权限或目录已删除，跳过而不中断整体扫描
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, matcher, depth + 1, maxDepth, out);
    } else if (entry.isFile() && matcher.test(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * 按 manifest 的路径模式查找会话文件，按修改时间倒序。
 * @param pattern 路径模式，如 `~/.claude/projects/**\/*.jsonl`
 * @param options 发现选项
 * @returns 文件绝对路径列表
 */
export function discoverSessionFiles(pattern: string, options: DiscoverOptions = {}): string[] {
  const expanded = expandPatternPath(pattern);
  const matcher = globToRegExp(path.basename(expanded));

  let base: string;
  let recursive: boolean;
  const starIndex = expanded.indexOf('**');
  if (starIndex >= 0) {
    base = expanded.slice(0, starIndex).replace(/[\\/]+$/, '');
    recursive = true;
  } else {
    base = path.dirname(expanded);
    recursive = false;
  }

  const found: string[] = [];
  walk(base, matcher, 0, recursive ? (options.maxDepth ?? MAX_DEPTH) : 0, found);

  const withTime = found.map((file) => {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    return { file, mtimeMs };
  });
  withTime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const limit = options.limit ?? 200;
  return withTime.slice(0, limit).map((item) => item.file);
}

/** @description: 后台采集使用异步目录查询，跳过符号链接并限制遍历范围。 */
export async function discoverSessionFilesAsync(
  pattern: string,
  options: DiscoverOptions = {},
): Promise<string[]> {
  const expanded = expandPatternPath(pattern);
  const marker = expanded.indexOf('**');
  const base =
    marker >= 0 ? expanded.slice(0, marker).replace(/[\\/]+$/, '') : path.dirname(expanded);
  const matcher = globToRegExp(path.basename(expanded));
  const found: Array<{ file: string; mtimeMs: number }> = [];
  let visited = 0;
  const walkAsync = async (dir: string, depth: number): Promise<void> => {
    if (depth > (marker >= 0 ? (options.maxDepth ?? MAX_DEPTH) : 0) || visited >= 20000) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++visited > 20000) break;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walkAsync(file, depth + 1);
      else if (entry.isFile() && matcher.test(entry.name)) {
        try {
          found.push({ file, mtimeMs: (await stat(file)).mtimeMs });
        } catch {
          /* 删除竞争。 */
        }
      }
    }
  };
  await walkAsync(base, 0);
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, options.limit ?? 200)
    .map((item) => item.file);
}
