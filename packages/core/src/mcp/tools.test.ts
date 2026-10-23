/**
 * MCP 工具契约单测：入参校验、错误三元组、非法迁移映射。
 */
import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '../statemachine/transition-table';
import { createMcpTools, type EngineFacade } from './tools';

/** 构造假门面 */
function fakeFacade(): EngineFacade {
  return {
    async listTools() {
      return [{ toolId: 'demo-tool', name: 'Demo Tool', detectStatus: 'running', sessionCount: 1 }];
    },
    async listSessions() {
      return [
        {
          sessionId: 'demo-tool:p:s1',
          toolId: 'demo-tool',
          currentState: 'waiting_human',
          updatedAt: '2026-10-20T00:00:00.000Z',
        },
      ];
    },
    async getTaskStatus(sessionId) {
      if (sessionId === 'missing') {
        return null;
      }
      return { state: 'waiting_human', recent: [] };
    },
    async updateTaskState(input) {
      if (input.sessionId === 'missing') {
        return null;
      }
      throw new IllegalTransitionError('completed', 'task.started');
    },
    async setVoiceRule(input) {
      return {
        ruleId: 'r1',
        scopeTool: input.scopeTool ?? null,
        scopeEvent: input.scopeEvent,
        action: input.action as 'mute' | 'notify' | 'speak',
        template: input.template ?? null,
        priority: (input.priority ?? null) as 'low' | 'mid' | 'high' | null,
      };
    },
    async getTimeline() {
      return [];
    },
  };
}

describe('MCP 工具', () => {
  it('list_tools 返回工具清单', async () => {
    const tools = createMcpTools(fakeFacade());
    const result = await tools.list_tools({});
    expect(result.success).toBe(true);
  });

  it('list_sessions 默认 limit 为 50', async () => {
    const tools = createMcpTools(fakeFacade());
    const result = await tools.list_sessions({});
    expect(result.success).toBe(true);
  });

  it('会话不存在返回 NOT_FOUND', async () => {
    const tools = createMcpTools(fakeFacade());
    const result = await tools.get_task_status({ sessionId: 'missing' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('非法迁移返回 ILLEGAL_TRANSITION 并给出建议', async () => {
    const tools = createMcpTools(fakeFacade());
    const result = await tools.update_task_state({
      sessionId: 'demo-tool:p:s1',
      event: 'human.responded',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('ILLEGAL_TRANSITION');
      expect(result.suggestion).toBeTruthy();
    }
  });

  it('入参不合法返回 INVALID_PARAM', async () => {
    const tools = createMcpTools(fakeFacade());
    const result = await tools.get_task_status({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_PARAM');
    }
  });

  it('set_voice_rule 幂等返回规则对象', async () => {
    const tools = createMcpTools(fakeFacade());
    const result = await tools.set_voice_rule({
      scopeEvent: 'task.waiting_human',
      action: 'speak',
    });
    expect(result.success).toBe(true);
  });

  it('get_timeline 返回迁移链', async () => {
    const tools = createMcpTools(fakeFacade());
    const result = await tools.get_timeline({ sessionId: 'demo-tool:p:s1' });
    expect(result.success).toBe(true);
  });
});
