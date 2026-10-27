/** 在 Electron 的 Node 模式自检打包产物；不打开窗口、模型、真实会话或用户数据库。 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.resolve(process.argv[2] ?? 'apps/desktop/release/mac-arm64/AgentCue.app');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const probe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const { gunzipSync } = require('node:zlib');
const resources = process.argv[1];
const expectedVersion = process.argv[2];
const archive = path.join(resources, 'app.asar');
const appRequire = createRequire(path.join(archive, 'package.json'));
assert.equal(appRequire('./package.json').productName, 'AgentCue');
assert.equal(appRequire('./package.json').version, expectedVersion);
const core = appRequire('@awm/core');
assert.equal(core.APP_DISPLAY_NAME, 'AgentCue');
assert.equal(path.basename(core.defaultDataDir()), 'AI Workflow Monitor');
const Database = appRequire('better-sqlite3');
const db = new Database(':memory:');
assert.equal(db.prepare('select 1 as value').get().value, 1);
db.close();
const sherpa = createRequire(path.join(resources, 'sherpa-tts/package.json'))('sherpa-onnx-node');
assert.equal(typeof sherpa.OfflineTts, 'function');
assert.equal(fs.existsSync(path.join(archive, 'node_modules/sherpa-onnx-node')), false, 'TTS must not be duplicated');
assert.equal(fs.existsSync(path.join(archive, 'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c')), false);
assert.ok(gunzipSync(fs.readFileSync(path.join(resources, 'licenses/Chromium-LICENSES.html.gz'))).length > 1000);
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'Sherpa-ONNX-LICENSE.txt', 'Electron-LICENSE.txt']) {
  assert.ok(fs.statSync(path.join(resources, 'licenses', file)).size > 100);
}
const office = fs.readFileSync(path.join(archive, 'dist/renderer/office.js'), 'utf8');
const styleList = office.match(/const OFFICE_DESK_STYLES = \[([\s\S]*?)\]/);
assert.ok(styleList, 'the workstation style list is present');
const usedDesks = new Set((styleList[1].match(/'desk-[a-z0-9-]+'/g) || []).map(name => name.slice(1, -1)));
const emptyDesk = office.match(/'desk-empty-[a-z0-9-]+'/);
assert.ok(emptyDesk, 'the uninstalled workstation style is present');
usedDesks.add(emptyDesk[0].slice(1, -1));
const officeDir = path.join(archive, 'dist/renderer/assets/office');
const desks = fs.readdirSync(officeDir).filter(file => file.endsWith('.webp'));
assert.equal(desks.length, usedDesks.size, 'only active illustrations belong in the app');
for (const name of usedDesks) assert.ok(fs.existsSync(path.join(officeDir, name + '.webp')));
assert.ok(fs.readFileSync(path.join(archive, 'dist/renderer/index.html'), 'utf8').includes('<title>AgentCue</title>'));
const input = new PassThrough();
const output = new PassThrough();
let text = '';
output.on('data', chunk => { text += chunk.toString(); });
const done = appRequire('./dist/resources/mcp-stdio/stdio.js').runStdio(input, output, new PassThrough());
input.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}}) + '\n' +
  JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}) + '\n' +
  JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'}) + '\n');
done.then(() => {
  const responses = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, 'ai-workflow-monitor');
  assert.equal(responses[1].result.tools.length, 6);
  process.stdout.write(JSON.stringify({version:expectedVersion, platform:process.platform, arch:process.arch,
    sqlite:'ok', localTts:'ok', mcpTools:6, illustrations:desks.length}) + '\n');
}).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
`;

try {
  const mac = existsSync(path.join(appPath, 'Contents'));
  const resources = path.join(appPath, mac ? 'Contents/Resources' : 'resources');
  const candidates = mac
    ? [path.join(appPath, 'Contents/MacOS/AgentCue')]
    : [path.join(appPath, 'AgentCue.exe'), path.join(appPath, 'agentcue')];
  const executable = candidates.find((file) => existsSync(file));
  if (!executable) throw new Error(`找不到已打包的可执行文件：${appPath}`);
  const result = spawnSync(executable, ['-e', probe, resources, version], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr ?? `退出状态 ${result.status}`);
  }
  process.stdout.write('安装包自检通过（仅内存 SQLite、TTS 运行库和 MCP 枚举，无音频输出）。\n');
} catch (error) {
  process.stderr.write(`[verify-package] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
