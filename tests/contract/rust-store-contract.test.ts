import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MIGRATIONS } from '@awm/store';

it('keeps Rust SQLite migration SQL identical to the shipping store', () => {
  for (const migration of MIGRATIONS) {
    const file = new URL(
      `../../crates/agentcue-store/migrations/${String(migration.version).padStart(3, '0')}.sql`,
      import.meta.url,
    );
    expect(readFileSync(file, 'utf8')).toBe(migration.sql);
  }
});
