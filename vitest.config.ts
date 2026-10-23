/**
 * 全仓单测入口配置（L1 验证）。
 * - packages 下的 *.test.ts 与源码同层
 * - tests 目录下为契约测试、集成测试
 * - 通过 alias 直接指向各包 TS 源码，无需先 build 即可跑测试
 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/** 仓库根目录 */
const root = process.cwd();

export default defineConfig({
  resolve: {
    alias: {
      '@awm/schema': path.resolve(root, 'packages/schema/src/index.ts'),
      '@awm/store': path.resolve(root, 'packages/store/src/index.ts'),
      '@awm/core': path.resolve(root, 'packages/core/src/index.ts'),
      '@awm/adapters': path.resolve(root, 'packages/adapters/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/release/**'],
    testTimeout: 10_000,
  },
});
