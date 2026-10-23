/**
 * 构建产物资源拷贝。
 *
 * 1. 渲染层静态资源（html/css）→ dist/renderer
 * 2. 内置适配器 manifest → dist/resources/adapters（主进程按 __dirname 相对定位）
 *
 * 不引入构建工具，保持零依赖：Node 内置 fs 足够。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 当前文件所在目录（apps/desktop/scripts） */
const here = path.dirname(fileURLToPath(import.meta.url));

/** 应用目录（apps/desktop） */
const appDir = path.resolve(here, '..');

/** dist 根目录 */
const distDir = path.join(appDir, 'dist');

/**
 * 拷贝目录，源不存在时打印告警而不是中断构建。
 * @param from 源目录
 * @param to 目标目录
 * @param label 日志标签
 */
function copyDir(from, to, label) {
  if (!existsSync(from)) {
    process.stderr.write(`[copy-assets] 跳过 ${label}：源目录不存在 ${from}\n`);
    return;
  }
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  process.stdout.write(`[copy-assets] ${label} → ${path.relative(appDir, to)}\n`);
}

// 1) 渲染层静态资源
const rendererSrc = path.join(appDir, 'src/renderer');
const rendererDist = path.join(distDir, 'renderer');
mkdirSync(rendererDist, { recursive: true });
for (const name of readdirSync(rendererSrc)) {
  if (name.endsWith('.html') || name.endsWith('.css')) {
    cpSync(path.join(rendererSrc, name), path.join(rendererDist, name));
  }
}
process.stdout.write(`[copy-assets] 渲染层静态资源 → ${path.relative(appDir, rendererDist)}\n`);

// 2) 内置适配器 manifest
copyDir(
  path.resolve(appDir, '../../packages/adapters/resources/adapters'),
  path.join(distDir, 'resources/adapters'),
  '内置适配器 manifest',
);

// The bridge is a build resource; it shares the desktop's existing core/schema dependencies.
const bridgeSrc = path.resolve(appDir, '../mcp-stdio/dist');
if (!existsSync(path.join(bridgeSrc, 'stdio.js'))) {
  throw new Error('MCP 桥接尚未构建，请先运行 pnpm --filter @awm/mcp-stdio build');
}
copyDir(bridgeSrc, path.join(distDir, 'resources/mcp-stdio'), 'MCP stdio 桥接');
