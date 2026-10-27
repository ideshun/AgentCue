/* eslint-disable @typescript-eslint/no-require-imports */
/* global __dirname, module, process, require */

const fs = require('node:fs');
const path = require('node:path');

const appDir = path.resolve(__dirname, '..');
const rootNodeModules = path.resolve(appDir, '../../node_modules');

function archName(value) {
  if (typeof value === 'string') return value.toLowerCase();
  const names = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
  return names[value] ?? 'unknown';
}

/** electron-builder afterPack: stage the JS shim and exact optional native package for this target. */
module.exports = async function stageSherpaRuntime(context) {
  const arch = archName(context.arch);
  const platform =
    context.electronPlatformName === 'win32' ? 'win' : String(context.electronPlatformName);
  const appBundle =
    platform === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : context.appOutDir;
  const resourcesDir =
    platform === 'darwin'
      ? path.join(appBundle, 'Contents/Resources')
      : path.join(appBundle, 'resources');
  const runtimeRoot = path.join(resourcesDir, 'sherpa-tts');
  const modulesDir = path.join(runtimeRoot, 'node_modules');
  const jsPackage = path.join(rootNodeModules, 'sherpa-onnx-node');
  const nativePackage = path.join(rootNodeModules, `sherpa-onnx-${platform}-${arch}`);

  if (!fs.existsSync(path.join(nativePackage, 'package.json'))) {
    throw new Error(`未安装 ${platform}-${arch} 的 sherpa-onnx 原生包；无法生成完整安装包。`);
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  if (!fs.existsSync(path.join(jsPackage, 'package.json')))
    throw new Error(`找不到 sherpa-onnx-node 运行时：${jsPackage}`);
  fs.mkdirSync(modulesDir, { recursive: true });
  fs.cpSync(jsPackage, path.join(modulesDir, 'sherpa-onnx-node'), { recursive: true });

  fs.cpSync(nativePackage, path.join(modulesDir, path.basename(nativePackage)), {
    recursive: true,
  });

  const licensesDir = path.join(resourcesDir, 'licenses');
  fs.mkdirSync(licensesDir, { recursive: true });
  const projectRoot = path.resolve(appDir, '../..');
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(licensesDir, file));
  }
  // 随源码固定 Electron 版本的许可材料，避免不同平台的 pnpm 链接布局差异。
  for (const file of ['Electron-LICENSE.txt', 'Chromium-LICENSES.html.gz']) {
    fs.copyFileSync(path.join(appDir, 'build/licenses', file), path.join(licensesDir, file));
  }
  fs.copyFileSync(
    path.join(appDir, 'build/licenses/Apache-2.0.txt'),
    path.join(licensesDir, 'Sherpa-ONNX-LICENSE.txt'),
  );
  process.stdout.write(`[after-pack] sherpa-onnx ${platform}-${arch} → Resources/sherpa-tts\n`);
};
