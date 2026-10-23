import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardQuerySchema, TASK_STATES, type BoardItem, type TaskState } from '@awm/schema';
import { listSessions, tables, upsertTool } from '@awm/store';
import { Engine } from '../../apps/desktop/src/main/engine-host';
import { DesktopFacade } from '../../apps/desktop/src/main/facade';
import type { MonitorService } from '../../apps/desktop/src/main/monitor-service';

let root: string;
let engine: Engine;
let facade: DesktopFacade;
let history: BoardItem[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'awm-board-fixture-'));
  engine = new Engine(root);
  history = [];
  const monitor = {
    get historyTasks() {
      return history;
    },
    adapters: [],
    lastSummary: null,
    sourceReason: () => undefined,
  } as unknown as MonitorService;
  facade = new DesktopFacade(engine, monitor);
  for (const toolId of ['fixture-a', 'fixture-b'])
    upsertTool(engine.database, {
      toolId,
      name: toolId,
      adapterId: toolId,
      detectStatus: 'installed',
    });
});

afterEach(async () => {
  await engine.stop();
  rmSync(root, { recursive: true, force: true });
});

function add(
  items: Array<{ id: string; state: TaskState; title?: string; toolId?: string; time?: string }>,
): void {
  engine.database
    .insert(tables.sessions)
    .values(
      items.map((item) => ({
        sessionId: item.id,
        toolId: item.toolId ?? 'fixture-a',
        title: item.title ?? item.id,
        currentState: item.state,
        updatedAt: item.time ?? '2026-10-20T12:00:00.000Z',
      })),
    )
    .run();
}

describe('board grouped query', () => {
  it('returns an old waiting task even when more than 200 newer completed tasks exist', async () => {
    add(
      Array.from({ length: 205 }, (_, index) => ({
        id: `done-${String(index).padStart(3, '0')}`,
        state: 'completed' as const,
      })),
    );
    add([{ id: 'older-waiting', state: 'waiting_human', time: '2026-10-01T12:00:00.000Z' }]);
    const board = await facade.getBoard(boardQuerySchema.parse({ limit: 20 }));
    expect(board.groups.find((group) => group.id === 'attention')).toMatchObject({
      total: 1,
      items: [{ sessionId: 'older-waiting' }],
    });
    expect(board.groups.find((group) => group.id === 'completed')).toMatchObject({ total: 205 });
    expect(board.groups.find((group) => group.id === 'completed')?.items).toHaveLength(20);
    expect((await facade.getOverview()).counts).toMatchObject({ waiting_human: 1, completed: 205 });
  });

  it('uses stable per-group cursors for equal timestamps without duplicate items', async () => {
    add(
      Array.from({ length: 7 }, (_, index) => ({
        id: `running-${index}`,
        state: 'running' as const,
      })),
    );
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const board = await facade.getBoard(
        boardQuerySchema.parse({ group: 'running', limit: 3, ...(cursor ? { cursor } : {}) }),
      );
      const group = board.groups[0]!;
      expect(group.total).toBe(7);
      ids.push(...group.items.map((item) => item.sessionId));
      cursor = group.nextCursor;
    } while (cursor);
    expect(ids).toEqual([
      'running-6',
      'running-5',
      'running-4',
      'running-3',
      'running-2',
      'running-1',
      'running-0',
    ]);
    expect(new Set(ids).size).toBe(7);
  });

  it('treats SQL wildcard characters as literal search text and applies the tool filter', async () => {
    add([
      { id: 'literal-a', state: 'running', title: '完成 100%_接口', toolId: 'fixture-a' },
      { id: 'literal-b', state: 'running', title: '完成 100%_接口', toolId: 'fixture-b' },
      { id: 'not-literal', state: 'running', title: '完成 100xx接口', toolId: 'fixture-a' },
    ]);
    const board = await facade.getBoard(
      boardQuerySchema.parse({ group: 'running', q: '100%_', toolId: 'fixture-a' }),
    );
    expect(board.groups[0]).toMatchObject({ total: 1, items: [{ sessionId: 'literal-a' }] });
  });

  it('keeps metadata in its own counted and pageable group without adding a workflow state', async () => {
    history.push(
      ...Array.from({ length: 3 }, (_, index): BoardItem => ({
        kind: 'history',
        sessionId: `fixture-a:history:${index}`,
        toolId: 'fixture-a',
        title: `历史 ${index}`,
        currentState: null,
        updatedAt: '2026-10-20T13:00:00.000Z',
        sourceStatus: 'completed',
      })),
    );
    const first = (await facade.getBoard(boardQuerySchema.parse({ group: 'history', limit: 2 })))
      .groups[0]!;
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(first.items.every((item) => item.kind === 'history' && item.currentState === null)).toBe(
      true,
    );
    const second = (
      await facade.getBoard(
        boardQuerySchema.parse({ group: 'history', limit: 2, cursor: first.nextCursor }),
      )
    ).groups[0]!;
    expect(second.total).toBe(3);
    expect(second.items).toHaveLength(1);
    expect(listSessions(engine.database)).toEqual([]);
    expect((await facade.getOverview()).attention).toBe(0);
    expect((await facade.listTools()).every((tool) => tool.sessionCount === 0)).toBe(true);
    expect(TASK_STATES).not.toContain('unknown');
  });

  it('rejects corrupt cursors and cursors reused for a different group or filter', async () => {
    add([
      { id: 'r-a', state: 'running' },
      { id: 'r-b', state: 'running' },
    ]);
    const first = (await facade.getBoard(boardQuerySchema.parse({ group: 'running', limit: 1 })))
      .groups[0]!;
    for (const query of [
      { group: 'running', cursor: 'not-json' },
      { group: 'failed', cursor: first.nextCursor },
      { group: 'running', q: 'different', cursor: first.nextCursor },
      { cursor: first.nextCursor },
    ])
      await expect(facade.getBoard(boardQuerySchema.parse(query))).rejects.toThrow(RangeError);
  });
});
