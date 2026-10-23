/**
 * @awm/adapters 统一出口。
 * 本包是唯一允许出现具体工具名的模块；core 不得出现工具名（契约测试断言）。
 */
export * from './loader';
export * from './registry';
export * from './discover';
export * from './claude-code/extract';
export * from './claude-code/hooks';
export * from './mcp-snippets';
export * from './validate';
export * from './metadata';
export * from './tool-hooks';
export * from './codebuddy-hooks';
export * from './cline-hooks';
