/** Export only public state contracts; no user data or runtime access. Run pnpm build first. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  TASK_STATES,
  EVENT_TYPES,
  NON_TRANSITION_EVENT_TYPES,
  TERMINAL_LIKE_STATES,
} = require('../packages/schema/dist/index.js');
const { TRANSITION_TABLE } = require('../packages/core/dist/statemachine/transition-table.js');
const { MIGRATIONS } = require('../packages/store/dist/migrations.js');
const content = [
  '# Generated from @awm/schema and @awm/core. Run pnpm rust:contract to update.',
  `# states: ${TASK_STATES.join(' ')}`,
  `# events: ${EVENT_TYPES.join(' ')}`,
  `# observations: ${NON_TRANSITION_EVENT_TYPES.join(' ')}`,
  `# terminal-like: ${TERMINAL_LIKE_STATES.join(' ')}`,
  ...TASK_STATES.flatMap((state) =>
    EVENT_TYPES.map((event) => `${state}\t${event}\t${TRANSITION_TABLE[state][event] ?? '-'}`),
  ),
  '',
].join('\n');
const target = new URL('../crates/agentcue-core/tests/fixtures/transitions.tsv', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== content) throw new Error('Rust contract fixture is stale');
  process.stdout.write('Rust 状态契约与当前 TS 实现一致。\n');
} else {
  writeFileSync(target, content);
  process.stdout.write(`已导出 ${TASK_STATES.length * EVENT_TYPES.length} 种状态/事件组合。\n`);
}

const migrationDirectory = new URL('../crates/agentcue-store/migrations/', import.meta.url);
if (!process.argv.includes('--check')) mkdirSync(migrationDirectory, { recursive: true });
for (const migration of MIGRATIONS) {
  const file = new URL(`${String(migration.version).padStart(3, '0')}.sql`, migrationDirectory);
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8') !== migration.sql)
      throw new Error(`Stale SQL migration ${migration.version}`);
  } else writeFileSync(file, migration.sql);
}

// Shared resources are compiled from the shipping adapter/config definitions; no client files are read.
const { parse } = require('yaml');
const { adapterManifestSchema, defaultSettings } = require('../packages/schema/dist/index.js');
const { readdirSync } = require('node:fs');
const { HOOK_TOOLS, hookIntegrations } = require('../apps/desktop/dist/main/hook-setup.js');
const { mcpSnippets } = require('../packages/adapters/dist/index.js');
const { NATIVE_VOICE_ALLOWLIST } = require('../packages/core/dist/voice/tts.js');
const { KOKORO_SPEC, ZIPVOICE_SPEC } = require('../apps/desktop/dist/main/model-manager.js');
const { TOOL_DEFINITIONS } = require('../apps/mcp-stdio/dist/tools.js');
const { DEFAULT_RULES, LEGACY_RULES } = require('../apps/desktop/dist/main/defaults.js');
const resourceDir = new URL('../crates/agentcue-runtime/resources/', import.meta.url);
if (!process.argv.includes('--check')) mkdirSync(resourceDir, { recursive: true });
const sourceDir = new URL('../packages/adapters/resources/adapters/', import.meta.url);
const adapters = readdirSync(sourceDir)
  .filter((name) => name.endsWith('.manifest.yaml'))
  .sort()
  .map((name) => {
    const adapter = adapterManifestSchema.parse(
      parse(readFileSync(new URL(name, sourceDir), 'utf8')),
    );
    return {
      ...adapter,
      ...(HOOK_TOOLS[adapter.id] ? { hookConfig: HOOK_TOOLS[adapter.id] } : {}),
    };
  });
const launch = { command: '/__AGENTCUE_EXECUTABLE__', args: ['--mcp-stdio'], commandReady: true };
for (const [name, value] of Object.entries({
  'default-settings.json': defaultSettings(),
  'native-voices.json': NATIVE_VOICE_ALLOWLIST.map((rule) => ({ pattern: rule.pattern.source, language: rule.language.source })),
  'model-specs.json': [KOKORO_SPEC, ZIPVOICE_SPEC],
  'voice-defaults.json': { revision: 3, rules: DEFAULT_RULES, legacy: LEGACY_RULES },
  'adapters.json': adapters,
  'hook-templates.json': hookIntegrations(launch, () => ({ lastEventAt: null, enabled: true })),
  'mcp-templates.json': mcpSnippets(launch),
  'mcp-tools.json': TOOL_DEFINITIONS,
})) {
  const content = JSON.stringify(value, null, 2) + '\n';
  const target = new URL(name, resourceDir);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== content)
      throw new Error(`Rust resource is stale: ${name}`);
  } else writeFileSync(target, content);
}

// Synthetic adapter fixtures exercise the shipping parser; no installed client data is accessed.
const { extractSourceBatch, parseJsonl } = require('../packages/adapters/dist/index.js');
const { extractUserTitles } = require('../packages/adapters/dist/user-title.js');
const { compactSpeechReferences } = require('../packages/schema/dist/index.js');
const sourceCases = [];
const event = (type, turnId, extra = {}) => ({
  timestamp: '2026-11-08T00:00:00.000Z', type: 'event_msg',
  payload: { type, ...(turnId ? { turn_id: turnId } : {}), ...extra },
});
const user = (message) => ({ type: 'event_msg', payload: { type: 'user_message', message } });
function sourceCase(name, id, rows, size, initial = {}) {
  const manifest = adapters.find((v) => v.id === id);
  const ctx = { toolId: id, project: 'fixture-project', sessionKey: 'fixture-session',
    sourcePath: `/synthetic/${id}/fixture.jsonl`, ...initial };
  let context = ctx.context;
  const batches = [];
  for (let i = 0; i < rows.length; i += size) {
    const input = rows.slice(i, i + size);
    const expected = extractSourceBatch(input, manifest, { ...ctx, context });
    batches.push({ rows: input, expected });
    context = expected.context;
  }
  sourceCases.push({ name, manifest, ctx, batches });
}
for (const id of ['claude-code', 'codex']) {
  const rows = parseJsonl(readFileSync(new URL(`../tests/contract/adapters/${id}/sample.jsonl`, import.meta.url), 'utf8')).rows;
  for (const size of [1, 2, 1000]) sourceCase(`${id}-fixture-batch-${size}`, id, rows, size);
}
const turns = [
  event('task_started', 'one'), user('改造 @minmetals-ui/packages/biz-components 的 org-user-group-picker 组件'),
  event('task_complete', 'one'), user('第二轮真实用户请求'), event('turn_started', 'two'),
  event('turn_complete', 'two', { error: 'failure' }), event('task_started', 'three'), event('turn_aborted', 'three'),
];
for (let size = 1; size <= turns.length; size += 1) sourceCase(`turns-batch-${size}`, 'codex', turns, size);
for (const source of [{ internal: 'maintenance' }, { subagent: 'review' },
  { subagent: { thread_spawn: { parent_thread_id: 'fixture', depth: 1 } } },
  { subagent: { other: 'fixture' } }, { subagent: { review: {} } }, 'cli']) {
  sourceCase(`source-${JSON.stringify(source)}`, 'codex', [{ type: 'session_meta', payload: { source } }, ...turns], 1);
}
sourceCase('legacy-file-identity', 'codex', [event('task_started'), event('task_complete')], 1,
  { title: '旧版真实标题', context: { taskId: 'known', title: '当前轮标题' } });
sourceCase('stable-js-numeric-hash', 'codex', [event('task_started', 'numeric', {
  integer: 1, fraction: 0.0000001, large: 100000000000000000000, huge: 1e21,
  negativeZero: -0, extra: { 2: 'second', 1: 'first', normal: true },
})], 1);
const userTexts = [
  '修复登录流程', '# AGENTS.md instructions\n<INSTRUCTIONS>内部规则</INSTRUCTIONS>',
  '<environment_context>环境</environment_context>', '<permissions instructions>只读</permissions instructions>',
  '<collaboration_mode>Default</collaboration_mode>', '<user_instructions>内部规则</user_instructions>',
  '# AGENTS.md instructions\n<INSTRUCTIONS>规则</INSTRUCTIONS>\n## My request:\n修复事件漏报',
  '<environment_context>环境İ</environment_context>\n补全任务看板',
  '<environment_context>环境</environment_context>\n## My request for Codex: 修复设置保存',
  '{"risk_level":"low","value":1}', '```md\n## My request:\n这是代码样本\n```',
  'const prompt = `\n## My request:\nhello\n`;', '😀'.repeat(80),
  '改造 @minmetals-ui/packages/biz-components 的 org-user-group-picker 组件',
];
const titleRows = userTexts.flatMap((text) => [
  { type: 'user', message: { content: text } }, user(text),
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
]);
titleRows.push({ type: 'assistant', message: { content: '不应出现的助手文本' } },
  { type: 'permission_request', message: { content: '{"risk_level":"low"}' } });
const references = ['@/Users/example/Data/Code/wukuang/ 审查这个项目',
  '改造 @minmetals-ui/packages/biz-components 的 org-user-group-picker 组件',
  '查看 @"/tmp/带 空格/文件.ts" 和 @C:\\work\\a\\b.ts', '**@/a/b/**，继续',
  '联系 name@example.com，打开 https://example.com/a，检查 api/v1 和 @someone'];
const fixture = { sources: sourceCases,
  titles: titleRows.map((row) => ({ row, expected: extractUserTitles(row) ?? null })),
  references: references.map((input) => ({ input, expected: compactSpeechReferences(input) })),
};
const adapterTarget = new URL('../crates/agentcue-adapters/tests/fixtures/contract.json', import.meta.url);
const adapterContent = JSON.stringify(fixture, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(adapterTarget, 'utf8') !== adapterContent) throw new Error('Rust adapter contract is stale');
} else {
  mkdirSync(new URL('./', adapterTarget), { recursive: true });
  writeFileSync(adapterTarget, adapterContent);
}

const { normalizeCursorHook, normalizeClineHook, normalizeCodeBuddyHook, normalizeClaudeCodeHook } = require('../packages/adapters/dist/index.js');
const hookCases = [];
const receivedAt = '2026-11-08T00:00:01.000Z';
function hookCase(tool, input, phase) {
  const normalizer = { cursor: normalizeCursorHook, cline: normalizeClineHook,
    codebuddy: normalizeCodeBuddyHook, 'claude-code': normalizeClaudeCodeHook }[tool];
  const options = { receivedAt, ...(phase ? { phase } : {}) };
  try { hookCases.push({ tool, input, options, expected: normalizer(input, options) }); }
  catch { hookCases.push({ tool, input, options, error: true }); }
}
for (const phase of ['beforeSubmitPrompt', 'preToolUse', 'stop', 'other']) {
  const input = { hook_event_name: phase, conversation_id: '会话/a?#', generation_id: 'turn:b', prompt: '检查 @repo/src/index.ts', status: 'completed', tool_name: 'AskQuestion' };
  hookCase('cursor', input);
  hookCase('cursor', { ...input, tool_name: 'Bash' });
}
for (const status of ['aborted', 'error', 'invalid']) hookCase('cursor', { hook_event_name: 'stop', conversation_id: 'fixture', generation_id: 'one', status });
for (const phase of ['TaskStart', 'TaskComplete', 'TaskCancel', 'Other']) hookCase('cline', {
  hookName: phase, taskId: 'fixture-private-task', timestamp: '1794096000000', taskStart: { taskMetadata: { initialTask: '检查 @repo/src/index.ts' } },
}, phase);
for (const stamp of ['0001', '-1', 'invalid', '9007199254740992']) hookCase('cline', { hookName: 'TaskComplete', taskId: 'fixture', timestamp: stamp });
for (const tool of ['claude-code', 'codebuddy']) {
  for (const phase of ['UserPromptSubmit', 'Stop', 'Notification', 'Other']) {
    for (const turn of [undefined, 'fixture-turn']) {
      const input = { hook_event_name: phase, session_id: 'fixture-session', prompt: '检查 @repo/src/index.ts',
        notification_type: 'permission_prompt', ...(turn ? { generation_id: turn, prompt_id: turn } : {}) };
      hookCase(tool, input);
      if (tool === 'claude-code') hookCase(tool, { ...input, transcript_path: '/synthetic/project/fixture.jsonl' });
    }
  }
}
for (const tool of ['cursor', 'cline', 'claude-code', 'codebuddy']) {
  hookCase(tool, null); hookCase(tool, {});
}
const hookTarget = new URL('../crates/agentcue-adapters/tests/fixtures/hooks.json', import.meta.url);
const hookContent = JSON.stringify(hookCases, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(hookTarget, 'utf8') !== hookContent) throw new Error('Rust hook contract is stale');
} else writeFileSync(hookTarget, hookContent);

const { CHONG_PHRASES } = require('../apps/desktop/dist/main/kokoro-pronunciation.js');
const pronunciationTarget = new URL('../crates/agentcue-tts/resources/pronunciation.json', import.meta.url);
const pronunciationContent = JSON.stringify(CHONG_PHRASES, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(pronunciationTarget, 'utf8') !== pronunciationContent) throw new Error('Rust pronunciation contract is stale');
} else writeFileSync(pronunciationTarget, pronunciationContent);
