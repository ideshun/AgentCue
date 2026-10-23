import { eq } from 'drizzle-orm';
import { sourceTaskContextSchema, type SourceCheckpoint } from '@awm/schema';
import type { AppDb } from '../db';
import { sourceCheckpoints, sourceReceipts, stateEvents } from '../schema';

/** @description: 返回最近一次成功提交的字节位置。 */
export function getSourceCheckpoint(db: AppDb, sourcePath: string): SourceCheckpoint | undefined {
  const row = db
    .select()
    .from(sourceCheckpoints)
    .where(eq(sourceCheckpoints.sourcePath, sourcePath))
    .get();
  if (!row) return undefined;
  let context: SourceCheckpoint['context'] = null;
  if (row.context) {
    try {
      const parsed = sourceTaskContextSchema.safeParse(JSON.parse(row.context));
      if (parsed.success) context = parsed.data;
    } catch {
      // 旧记录或损坏的可选元数据不影响来源位置读取。
    }
  }
  return { ...row, context };
}

/** @description: 由消费事务提交位置，读取失败时不得调用。 */
export function saveSourceCheckpoint(db: AppDb, checkpoint: SourceCheckpoint): void {
  const values = {
    ...checkpoint,
    context: checkpoint.context ? JSON.stringify(checkpoint.context) : null,
  };
  db.insert(sourceCheckpoints)
    .values(values)
    .onConflictDoUpdate({
      target: sourceCheckpoints.sourcePath,
      set: values,
    })
    .run();
}

/** @description: 在推进状态机前排除已处理的来源事件。 */
export function hasSourceEvent(db: AppDb, eventId: string): boolean {
  return (
    !!db
      .select({ id: sourceReceipts.eventId })
      .from(sourceReceipts)
      .where(eq(sourceReceipts.eventId, eventId))
      .get() ||
    !!db
      .select({ id: stateEvents.eventId })
      .from(stateEvents)
      .where(eq(stateEvents.eventId, eventId))
      .get()
  );
}

export function recordSourceEvent(db: AppDb, eventId: string): void {
  db.insert(sourceReceipts)
    .values({ eventId, processedAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
}
