import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const source = new URL('../apps/desktop/dist/renderer/', import.meta.url);
const output = new URL('../apps/tauri/dist/', import.meta.url);
rmSync(output, { recursive: true, force: true });
cpSync(source, output, { recursive: true });
const index = new URL('index.html', output);
const html = readFileSync(index, 'utf8')
  .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/i, '')
  .replace('<div class="brand">', '<div class="brand" data-tauri-drag-region="deep">')
  .replace(
    '<header class="pagehead" id="topbar">',
    '<header class="pagehead" id="topbar" data-tauri-drag-region="deep">',
  )
  .replace('<script src="./api.js">', '<script src="./tauri-bridge.js"></script>\n    <script src="./api.js">');
writeFileSync(index, html);
const bridge = readFileSync(new URL('../apps/tauri/bridge.js', import.meta.url), 'utf8');
writeFileSync(new URL('tauri-bridge.js', output), bridge.replace('__AGENTCUE_PLATFORM__', process.platform));
