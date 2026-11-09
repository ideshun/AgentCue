import { execFileSync } from 'node:child_process';
import { it } from 'vitest';

it('keeps Rust settings, adapters, hooks, MCP snippets and voice rules aligned with shipping sources', () => {
  execFileSync(process.execPath, ['scripts/export-rust-contract.mjs', '--check'], {
    cwd: new URL('../../', import.meta.url),
    stdio: 'pipe',
  });
});
