import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  NON_TRANSITION_EVENT_TYPES,
  TASK_STATES,
  TERMINAL_LIKE_STATES,
} from '@awm/schema';
import { resolveTransition } from '@awm/core';

describe('Rust migration state contract', () => {
  it('keeps every native transition fixture tied to the shipping TS implementation', () => {
    const actual = readFileSync(
      new URL('../../crates/agentcue-core/tests/fixtures/transitions.tsv', import.meta.url),
      'utf8',
    );
    const expected = [
      '# Generated from @awm/schema and @awm/core. Run pnpm rust:contract to update.',
      `# states: ${TASK_STATES.join(' ')}`,
      `# events: ${EVENT_TYPES.join(' ')}`,
      `# observations: ${NON_TRANSITION_EVENT_TYPES.join(' ')}`,
      `# terminal-like: ${TERMINAL_LIKE_STATES.join(' ')}`,
      ...TASK_STATES.flatMap((state) =>
        EVENT_TYPES.map((event) => `${state}\t${event}\t${resolveTransition(state, event) ?? '-'}`),
      ),
      '',
    ].join('\n');
    expect(actual).toBe(expected);
  });
});
