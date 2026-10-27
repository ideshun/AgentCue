import type { TaskState } from './state';
import type { BoardItem } from './board';

/** Office previews are bounded; counts cover every visible workflow session for the tool. */
export interface OfficeWorkstation {
  toolId: string;
  counts: Record<TaskState, number>;
  /** Up to four recent tasks per group: waiting, running, issues, ended. No history snapshots. */
  tasks: BoardItem[];
}

export interface OfficeSnapshot {
  workstations: OfficeWorkstation[];
  generatedAt: string;
}
