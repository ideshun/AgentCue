/**
 * 会话文件发现单测：覆盖递归/单层两种模式与数量上限。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSessionFiles, expandPatternPath } from './discover';

/** 临时目录 */
let root = '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'awm-discover-'));
  mkdirSync(path.join(root, 'proj-a'), { recursive: true });
  mkdirSync(path.join(root, 'proj-b'), { recursive: true });
  writeFileSync(path.join(root, 'proj-a', 'a.jsonl'), '{}\n');
  writeFileSync(path.join(root, 'proj-b', 'b.jsonl'), '{}\n');
  writeFileSync(path.join(root, 'proj-b', 'ignore.txt'), 'x');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discoverSessionFiles', () => {
  it('递归模式能找到多层目录下的同名后缀文件', () => {
    const files = discoverSessionFiles(path.join(root, '**', '*.jsonl'));
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.endsWith('.jsonl'))).toBe(true);
  });

  it('单层模式不会进入子目录', () => {
    const files = discoverSessionFiles(path.join(root, '*.jsonl'));
    expect(files).toHaveLength(0);
  });

  it('按 limit 截断', () => {
    const files = discoverSessionFiles(path.join(root, '**', '*.jsonl'), { limit: 1 });
    expect(files).toHaveLength(1);
  });

  it('目录不存在时返回空数组而不是抛错', () => {
    expect(discoverSessionFiles(path.join(root, 'missing', '**', '*.jsonl'))).toEqual([]);
  });
});

describe('expandPatternPath', () => {
  it('展开 ~ 为绝对路径', () => {
    expect(path.isAbsolute(expandPatternPath('~/a/b.jsonl'))).toBe(true);
  });
});
