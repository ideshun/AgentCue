/**
 * 各 IDE Hook 的放行应答。零依赖纯函数：tool-hook-client 与加载失败的兜底路径共用，
 * 改动只需维护这一处。输出只含各客户端原生的放行字段。
 * 注意：entry.ts 的 hookLoadFailed 在模块全挂的最坏情况下保留了一份内联副本
 * （不依赖任何加载）；两处一致性由 tool-hook-client.test.ts 的 it.each 锁定。
 */

/**
 * 按工具与阶段返回放行应答对象。
 * @param tool `--tool-hook` 的工具 id
 * @param phase `--hook-phase` 或负载里的 hook_event_name
 */
export function hookAcknowledgment(tool: string | undefined, phase: string | undefined): object {
  if (tool === 'cline') return { cancel: false };
  // CodeBuddy IDE 会把未 suppress 的 UserPromptSubmit stdout 注入 Agent 上下文。
  if (tool === 'codebuddy') return { continue: true, suppressOutput: true };
  // Claude Code 同样会注入 UserPromptSubmit 的纯文本 stdout，所有阶段都只输出空 JSON 对象。
  if (tool === 'claude-code') return {};
  return tool === 'cursor' && phase === 'beforeSubmitPrompt' ? { continue: true } : {};
}
