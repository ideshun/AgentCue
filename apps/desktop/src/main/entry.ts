/** Dispatch lightweight subprocesses before desktop imports, single-instance locks, or SQLite. */
import path from 'node:path';

function hookLoadFailed(): void {
  const tool = process.argv[process.argv.indexOf('--tool-hook') + 1];
  const phaseIndex = process.argv.indexOf('--hook-phase');
  const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : undefined;
  const acknowledgment = tool === 'cline' ? { cancel: false }
    : tool === 'codebuddy' ? { continue: true, suppressOutput: true }
      // Claude Code 会把 UserPromptSubmit 的纯文本 stdout 注入上下文，这里也只输出空 JSON 对象。
      : tool === 'claude-code' ? {}
        : tool === 'cursor' && phase === 'beforeSubmitPrompt' ? { continue: true } : {};
  const timer = setTimeout(() => process.exit(0), 20);
  try {
    process.stdout.write(`${JSON.stringify(acknowledgment)}\n`, () => {
      clearTimeout(timer);
      process.exit(0);
    });
  } catch {
    clearTimeout(timer);
    process.exit(0);
  }
}

if (process.argv.includes('--tool-hook')) {
  void import('./tool-hook-client')
    .then((bridge) => bridge.runToolHookCli(process.argv))
    .then(
      () => process.exit(0),
      hookLoadFailed,
    );
} else if (process.argv.includes('--mcp-stdio')) {
  const bridgePath = path.join(__dirname, '../resources/mcp-stdio/stdio.js');
  void import(bridgePath)
    .then((bridge: { runStdio: () => Promise<void> }) => bridge.runStdio())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(
          `MCP 桥接失败：${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      },
    );
} else {
  void import('./index');
}
