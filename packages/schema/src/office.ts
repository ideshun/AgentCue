import type { TaskState } from './state';
import type { BoardItem } from './board';

/** Office previews are bounded; counts cover every visible workflow session for the tool. */
export interface OfficeWorkstation {
  toolId: string;
  counts: Record<TaskState, number>;
  /** Latest recorded event for a visible session, independent of task preview limits. */
  lastEventAt: string | null;
  /** Up to five recent tasks per group: waiting, running, issues, ended. No history snapshots. */
  tasks: BoardItem[];
  /** Recent attention tasks with unread notifications for their latest attention event. */
  attentionTasks?: (BoardItem & { attentionEventId?: string })[];
  /** Full number of unread attention tasks, independent of the preview limit. */
  attentionCount?: number;
  /** Full unread counts by state; employee status never depends on a bounded preview. */
  attentionCounts?: Pick<Record<TaskState, number>, 'waiting_human' | 'failed' | 'timeout'>;
}

export interface OfficeSnapshot {
  workstations: OfficeWorkstation[];
  generatedAt: string;
}
