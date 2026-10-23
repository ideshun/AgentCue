/**
 * MCP 工具契约测试：桥接进程声明的工具名必须与 core 的 MCP_TOOL_NAMES 一致。
 * 两处实现服务的都是同一批 AI 客户端，名字分叉会直接导致调用失败。
 */
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '@awm/core';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../../apps/mcp-stdio/src/tools';

describe('MCP 工具契约', () => {
  it('桥接进程与 core 的工具名完全一致', () => {
    expect([...TOOL_NAMES].sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('每个工具都有非空描述与 object 型入参 schema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(5);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('工具名唯一', () => {
    expect(new Set(TOOL_DEFINITIONS.map((tool) => tool.name)).size).toBe(TOOL_DEFINITIONS.length);
  });
});
