/**
 * ESLint 9 flat config。
 * 除基础规则外，落地设计文档 7.3 的两条硬约束：
 * - 禁止 console.log（日志统一走 logger）
 * - 禁止跨包深相对路径引用，必须使用包名（@awm/*）
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '**/dist/**',
      'release/**',
      'node_modules/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // TS 自带未定义检查；ESLint 的 no-undef 会把类型注解（TSTypeReference）误判为未定义变量
      'no-undef': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/packages/*/src/**', '../../packages/*'],
              message: '跨包引用请使用包名（如 @awm/schema），见设计文档 7.3 第 6 条。',
            },
          ],
        },
      ],
    },
  },
  {
    // 渲染层是 script（无 import/export），符号跨文件共享，不能按模块判定未使用
    files: ['apps/desktop/src/renderer/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
