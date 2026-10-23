/**
 * 使用能够加载项目 SQLite 原生模块的运行时启动 Vitest。
 * 探测只创建 :memory: 数据库，不重编译依赖，也不读取应用数据。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRequire = createRequire(path.join(root, 'package.json'));
const storeRequire = createRequire(path.join(root, 'packages/store/package.json'));
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const probeCode =
  "const Database=require(process.argv[1]);const db=new Database(':memory:');db.close();";

/** @description: 原生加载探测放在短命子进程，隔离不兼容的动态库。 */
function probe(binary, env, modulePath) {
  const result = spawnSync(binary, ['-e', probeCode, modulePath], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const diagnostic = result.error?.message ?? result.stderr?.trim() ?? '';
  return { ok: result.status === 0 && !result.error, diagnostic };
}

/** @description: 仅在 ABI 不匹配时尝试项目已有的 Electron，不隐式安装或 rebuild。 */
function selectRuntime(modulePath) {
  const env = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const node = probe(process.execPath, env, modulePath);
  if (node.ok) return { binary: process.execPath, env };
  const abiMismatch =
    /NODE_MODULE_VERSION|compiled against a different Node\.js version|Module did not self-register|ERR_DLOPEN_FAILED/i.test(
      node.diagnostic,
    );
  if (!abiMismatch) throw new Error('当前运行时无法加载项目 SQLite：\n' + node.diagnostic);
  let electron;
  try {
    electron = desktopRequire('electron');
  } catch (error) {
    throw new Error(
      'SQLite 与当前 Node ABI 不兼容，项目 Electron 也不可用：\n' +
        node.diagnostic +
        '\n' +
        String(error),
    );
  }
  if (typeof electron !== 'string' || !electron) throw new Error('Electron 可执行文件路径无效');
  const electronEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  const fallback = probe(electron, electronEnv, modulePath);
  if (!fallback.ok) {
    throw new Error(
      'Node 与 Electron 均无法加载项目 SQLite；未修改或重编译依赖。\nNode：' +
        node.diagnostic +
        '\nElectron：' +
        fallback.diagnostic,
    );
  }
  process.stderr.write(
    '[test-runtime] SQLite 与当前 Node ABI 不兼容，使用项目 Electron 的 Node 运行时。\n',
  );
  return { binary: electron, env: electronEnv };
}

/** @description: 原样传递 Vitest 子命令、文件过滤器与其他参数，保留真实退出状态。 */
async function main() {
  const sqlite = storeRequire.resolve('better-sqlite3');
  const vitest = path.join(
    path.dirname(projectRequire.resolve('vitest/package.json')),
    'vitest.mjs',
  );
  const runtime = selectRuntime(sqlite);
  const args = process.argv.slice(2);
  if (args.length === 0) args.push('run');
  await new Promise((resolve) => {
    const child = spawn(runtime.binary, [vitest, ...args], {
      cwd: root,
      env: runtime.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    const onInterrupt = () => child.kill('SIGINT');
    const onTerminate = () => child.kill('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    const cleanup = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    child.once('error', (error) => {
      cleanup();
      process.stderr.write('[test-runtime] 无法启动 Vitest：' + error.message + '\n');
      process.exitCode = 1;
      resolve();
    });
    child.once('exit', (code, signal) => {
      cleanup();
      process.exitCode =
        code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 1);
      resolve();
    });
  });
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    '[test-runtime] ' + (error instanceof Error ? error.message : String(error)) + '\n',
  );
  process.exitCode = 1;
}
