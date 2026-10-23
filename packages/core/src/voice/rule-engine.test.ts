/**
 * 播报规则引擎单测。
 * 覆盖：匹配优先级、动作判定、模板渲染与截断。
 */
import { describe, expect, it } from 'vitest';
import {
  defaultTemplateForEvent,
  matchRule,
  renderTemplate,
  resolveAction,
  truncateText,
  type TransitionSignal,
  type VoiceRule,
} from './rule-engine';

/** 构造迁移信号 */
function signal(overrides: Partial<TransitionSignal> = {}): TransitionSignal {
  return {
    toolId: 'demo-tool',
    eventType: 'task.waiting_human',
    sessionId: 'demo-tool:proj:s1',
    title: '重构登录模块',
    ...overrides,
  };
}

/** 构造规则 */
function rule(overrides: Partial<VoiceRule> = {}): VoiceRule {
  return {
    ruleId: 'r1',
    scopeTool: null,
    scopeEvent: '*',
    action: 'speak',
    ...overrides,
  };
}

describe('matchRule', () => {
  it('无命中规则时返回 null', () => {
    expect(matchRule([], signal())).toBeNull();
  });

  it('精确工具规则优先于通配规则', () => {
    const rules = [
      rule({ ruleId: 'wildcard', action: 'mute' }),
      rule({ ruleId: 'exact', scopeTool: 'demo-tool', action: 'speak' }),
    ];
    expect(matchRule(rules, signal())?.ruleId).toBe('exact');
  });

  it('精确事件规则优先于通配事件规则', () => {
    const rules = [
      rule({ ruleId: 'any-event', action: 'notify' }),
      rule({ ruleId: 'exact-event', scopeEvent: 'task.waiting_human', action: 'speak' }),
    ];
    expect(matchRule(rules, signal())?.ruleId).toBe('exact-event');
  });

  it('工具不匹配时规则不生效', () => {
    const rules = [rule({ scopeTool: 'other-tool', action: 'mute' })];
    expect(matchRule(rules, signal())).toBeNull();
  });
});

describe('resolveAction', () => {
  it('无规则时默认 speak 并使用对应事件模板', () => {
    const result = resolveAction([], signal());
    expect(result.action).toBe('speak');
    expect(result.text).toBe(renderTemplate(defaultTemplateForEvent(signal().eventType), signal()));
  });

  it('命中 mute 时不产生播报文本', () => {
    const result = resolveAction([rule({ action: 'mute' })], signal());
    expect(result.action).toBe('mute');
    expect(result.text).toBeUndefined();
  });

  it('命中 speak 且带模板时按模板渲染', () => {
    const result = resolveAction(
      [rule({ action: 'speak', template: '{tool} 等你拍板：{title}' })],
      signal(),
    );
    expect(result.text).toBe('demo-tool 等你拍板：重构登录模块');
  });

  it.each(['task.started', 'task.completed'] as const)(
    '%s 切换为播报后使用正确文案而非需要处理',
    (eventType) => {
      const event = signal({ eventType });
      const result = resolveAction([rule({ action: 'speak' })], event);
      expect(result.text).toBe(renderTemplate(defaultTemplateForEvent(eventType), event));
      expect(result.text).not.toContain('需要');
    },
  );

  it('旧静音规则中的空文案在启用播报后回落为事件文案', () => {
    const event = signal({ eventType: 'task.started' });
    expect(resolveAction([rule({ template: '' })], event).text).toBe(
      'demo-tool 开始处理，重构登录模块。',
    );
    expect(resolveAction([rule({ template: '  ' })], event).text).toBe(
      'demo-tool 开始处理，重构登录模块。',
    );
  });
});

describe('renderTemplate', () => {
  it('替换未知变量时保留原占位符', () => {
    expect(renderTemplate('{tool}-{unknown}', signal())).toBe('demo-tool-{unknown}');
  });

  it('工具使用显示名，缺省回落为id', () => {
    expect(renderTemplate('{tool}', signal({ toolName: '演示工具' }))).toBe('演示工具');
    expect(renderTemplate('{tool}', signal({ toolName: '  ' }))).toBe('demo-tool');
  });

  it('标题缺失时生成稳定短编号，不同任务可区分', () => {
    const first = renderTemplate('{title}', signal({ title: null }));
    expect(first).toMatch(/^任务 [A-F0-9]{8}$/);
    expect(renderTemplate('{title}', signal({ title: '  ' }))).toBe(first);
    expect(renderTemplate('{title}', signal({ title: null, sessionId: 'other-task' }))).not.toBe(
      first,
    );
  });

  it.each(['task.started', 'task.waiting_human', 'task.completed'] as const)(
    '%s 默认文案包含工具、长标题和事件进展',
    (eventType) => {
      const title = '任务标题'.repeat(20);
      const event = signal({ eventType, toolName: '演示工具', title });
      const text = renderTemplate(defaultTemplateForEvent(eventType), event);
      expect(text).toContain('演示工具');
      expect(text).toContain('任务标题');
      expect(text).toContain(
        eventType === 'task.started'
          ? '开始处理'
          : eventType === 'task.completed'
            ? '已经完成'
            : '确认',
      );
      expect(text.length).toBeLessThanOrEqual(200);
    },
  );
});

describe('truncateText', () => {
  it('截断不会切断 Unicode 字符形成替换乱码', () => {
    expect(truncateText('修复😀标题', 4)).toBe('修复😀…');
    expect(truncateText('😀', 1)).toBe('😀');
  });
  it('未超长时原样返回', () => {
    expect(truncateText('短文本', 40)).toBe('短文本');
  });

  it('超长时截断并以省略号结尾', () => {
    const text = 'a'.repeat(50);
    const result = truncateText(text, 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });
});
