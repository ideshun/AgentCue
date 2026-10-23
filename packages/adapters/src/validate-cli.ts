#!/usr/bin/env node
/**
 * `awm-adapter-validate`：校验一个或多个适配器 YAML。
 */
import { validateManifestFile } from './validate';

/**
 * CLI 入口。
 * @param argv 参数，默认 process.argv
 * @returns 退出码
 */
export function runValidateCli(argv: string[] = process.argv.slice(2)): number {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write('用法：awm-adapter-validate <manifest.yaml> [...]\n');
    return argv.length === 0 ? 1 : 0;
  }
  let failed = 0;
  for (const file of argv) {
    const result = validateManifestFile(file);
    if (result.ok) {
      process.stdout.write(`OK ${file} (${result.manifest?.id ?? '?'})\n`);
    } else {
      failed += 1;
      process.stderr.write(`FAIL ${file}\n`);
      for (const issue of result.issues) {
        process.stderr.write(`  - ${issue.path}: ${issue.message}\n`);
      }
    }
  }
  return failed === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(runValidateCli());
}
