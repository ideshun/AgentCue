import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, argument] = process.argv.slice(2);

try {
  if (command === 'check') {
    const tag = argument ?? process.env.RELEASE_TAG;
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (tag !== `v${version}`) throw new Error(`标签必须是 v${version}，收到 ${tag ?? '空值'}`);
    for (const directory of ['apps', 'packages']) {
      for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root, directory, entry.name, 'package.json');
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        if (pkg.version !== version) throw new Error(`${pkg.name} 的版本与根版本不一致`);
      }
    }
    process.stdout.write(`版本一致：${tag}\n`);
  } else if (command === 'checksums') {
    if (!argument) throw new Error('请提供安装包目录');
    const directory = path.resolve(argument);
    const files = readdirSync(directory).filter((file) => /\.(?:dmg|zip|exe|AppImage)$/.test(file)).sort();
    if (!files.length) throw new Error('没有找到安装包，不生成空校验文件');
    const lines = files.map((file) => {
      const hash = createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex');
      return `${hash}  ${file}`;
    });
    writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
    process.stdout.write(`已生成 ${files.length} 个安装包的 SHA-256 校验值\n`);
  } else {
    throw new Error('用法：node scripts/release.mjs check vX.Y.Z | checksums <目录>');
  }
} catch (error) {
  process.stderr.write(`[release] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
