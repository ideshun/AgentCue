import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = join(root, 'apps/tauri');
const args = process.argv.slice(2);
const allowed = { darwin: ['app', 'dmg'], win32: ['nsis'], linux: ['deb', 'appimage'] }[process.platform];
const bundles = args[0]?.split(',') ?? allowed;
if (args.length > 1 || !allowed || !bundles.every((bundle) => allowed.includes(bundle))) {
  throw new Error('Usage: pnpm tauri:bundle [app,dmg | nsis | deb,appimage]');
}
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run this script using pnpm tauri:bundle');
const env = {
  ...process.env,
  PATH: [process.env.PATH, join(homedir(), '.cargo/bin')].filter(Boolean).join(delimiter),
};
const run = (command, params, cwd = root, capture = false) =>
  execFileSync(command, params, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });

const triple = /^host: (.+)$/m.exec(run('rustc', ['-vV'], root, true))?.[1]?.trim();
if (!triple) throw new Error('Could not identify the Rust host target');
const { target_directory: target, packages } = JSON.parse(
  run('cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], root, true),
);
const { version } = JSON.parse(readFileSync(join(app, 'tauri.conf.json'), 'utf8'));
if (!packages.some((pkg) => pkg.name === 'agentcue-desktop' && pkg.version === version)) {
  throw new Error('Cargo and Tauri versions must match');
}
const ext = process.platform === 'win32' ? '.exe' : '';
run(process.execPath, [join(root, 'scripts/tauri-assets.mjs')]);
run('cargo', ['build', '--locked', '--release', '-p', 'agentcue-tts']);
mkdirSync(join(app, 'binaries'), { recursive: true });
copyFileSync(
  join(target, 'release', `agentcue-tts${ext}`),
  join(app, 'binaries', `agentcue-tts-${triple}${ext}`),
);
run(process.execPath, [
  pnpm, '--package', '@tauri-apps/cli@2.11.1', 'dlx', 'tauri', 'build',
  '--ci', '--config', 'bundle.conf.json', '--bundles', bundles.join(','), '--', '--locked',
], app);
