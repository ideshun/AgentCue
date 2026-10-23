import { describe, expect, it } from 'vitest';
import { extractSessionTitle, type RawLine } from './claude-code/extract';

function user(content: string): RawLine {
  return { type: 'user', message: { role: 'user', content } };
}

describe('真实用户标题', () => {
  it.each([
    user('修复登录流程'),
    { type: 'user', message: { content: [{ type: 'text', text: '修复登录流程' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: '修复登录流程' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复登录流程' }] } },
  ])('接受已验证的用户记录形状 %#', (row) => {
    expect(extractSessionTitle([row])).toBe('修复登录流程');
  });

  it.each([
    { type: 'assistant', message: { content: '助手答复' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '助手答复' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '{"risk_level":"low"}' } },
    { type: 'permission_request', message: { content: '{"risk_level":"low"}' } },
    { type: 'user', message: { role: 'assistant', content: '冲突角色' } },
    { type: 'unknown', message: { content: '未知记录' } },
  ])('不使用助手、审批或未知记录 %#', (row) => {
    expect(extractSessionTitle([row])).toBeUndefined();
  });

  it.each([
    '# AGENTS.md instructions\n<INSTRUCTIONS>内部规则</INSTRUCTIONS>',
    '<environment_context><cwd>/tmp/synthetic</cwd></environment_context>',
    '<permissions instructions>只读</permissions instructions>',
    '<collaboration_mode>Default</collaboration_mode>',
    '<user_instructions>内部规则</user_instructions>',
    '<environment_context>环境</environment_context>\n<permissions instructions>权限</permissions instructions>\n<collaboration_mode>模式</collaboration_mode>',
  ])('跳过独立控制上下文 %#', (text) => {
    expect(extractSessionTitle([user(text), user('真正的用户任务')])).toBe('真正的用户任务');
  });

  it.each(['## My request:', '## My request for Codex:'])('控制上下文和 %s 在同一记录时保留请求', (marker) => {
    const text = `# AGENTS.md instructions\n<INSTRUCTIONS>内部规则</INSTRUCTIONS>\n<environment_context>环境</environment_context>\n${marker}\n修复事件漏报`;
    expect(extractSessionTitle([user(text)])).toBe('修复事件漏报');
  });

  it('剥离前导环境块后保留后面的真实请求', () => {
    expect(extractSessionTitle([user('<environment_context>环境</environment_context>\n补全任务看板')])).toBe('补全任务看板');
  });

  it.each([
    '{"risk_level":"low","value":1}',
    '[{"role":"assistant"}]',
    'const risk_level = "low";',
    '```json\n{"risk_level":"low"}\n```',
  ])('保留合法用户 JSON 和代码 %#', (text) => {
    expect(extractSessionTitle([user(text)])).toBe(text.replace(/\s+/g, ' '));
  });

  it('代码围栏内的 My request 标题不是控制标记', () => {
    const text = '```md\n## My request:\n这是代码样本\n```';
    expect(extractSessionTitle([user(text)])).toBe(text.replace(/\s+/g, ' '));
  });

  it('未加围栏的用户代码也不会因字符串内的 My request 标题丢失开头', () => {
    const text = 'const prompt = `\n## My request:\nhello\n`;';
    expect(extractSessionTitle([user(text)])).toBe(text.replace(/\s+/g, ' ').slice(0, 40));
  });

  it('多段用户内容先过滤控制上下文，再保留同条消息中的请求', () => {
    expect(extractSessionTitle([{
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', content: [
          { type: 'input_text', text: '<environment_context>环境</environment_context>' },
          { type: 'input_text', text: '## My request: 修复设置保存' },
        ],
      },
    }])).toBe('修复设置保存');
  });
});
