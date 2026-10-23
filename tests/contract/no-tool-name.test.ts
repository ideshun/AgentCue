/**
 * 契约测试：core 不得出现任何具体工具名（详细设计 5.4 核心约束）。
 * 工具名只允许出现在 adapters 包与资源文件中。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** core 源码根目录 */
const CORE_SRC = path.resolve(process.cwd(), 'packages/core/src');

/** 禁止出现的工具名（小写匹配） */
const FORBIDDEN_TOOL_NAMES = ['claude', 'cursor', 'codex', 'windsurf', 'copilot', 'gemini'];

/**
 * 递归收集目录下的 .ts 文件。
 * @param dir 起始目录
 * @returns 文件路径列表
 */
function collectTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...collectTsFiles(full));
    } else if (full.endsWith('.ts')) {
      result.push(full);
    }
  }
  return result;
}

describe('core 零工具名约束', () => {
  it('packages/core/src 下不出现具体工具名', () => {
    const files = collectTsFiles(CORE_SRC);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const toolName of FORBIDDEN_TOOL_NAMES) {
        expect(text.includes(toolName), `${file} 出现工具名 ${toolName}`).toBe(false);
      }
    }
  });
});
