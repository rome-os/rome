// Wire types of the Concierge task panel, the assistant's own todo list. The
// server is packages/core/src/concierge and the client is packages/web.

/** What a task row is doing. The Concierge sets it; the system never derives it. */
export const CONCIERGE_TASK_STATES = [
  "next",
  "doing",
  "watching",
  "needs_user",
  "done",
  "dropped",
] as const;
export type ConciergeTaskState = (typeof CONCIERGE_TASK_STATES)[number];

/** The panel actions. Each one sends the Concierge a message, and never writes the row. */
export type ConciergeTaskAction = "stop" | "archive";

/** How many days of finished rows `GET /concierge/tasks` returns by default. */
export const CONCIERGE_DONE_DAYS = 7;

/** The longest `summary` the Concierge writes. */
export const CONCIERGE_TASK_SUMMARY_MAX_LENGTH = 120;

/** One row of the task panel. Times are epoch milliseconds. */
export interface ConciergeTaskDto {
  id: string;
  title: string;
  state: ConciergeTaskState;
  summary: string | null;
  waitingOn: string | null;
  dueAt: number | null;
  rank: number | null;
  /** The linked task chat, with its current name, or null when the row has none. */
  chat: { id: string; name: string } | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  archivedAt: number | null;
  /** Set when the Concierge did not pick up the row's task chat events after a retry. */
  notSynced: boolean;
}

/** `GET /concierge/tasks`. */
export interface ConciergeTasksResponse {
  tasks: ConciergeTaskDto[];
}

/** Payload of the `task_upsert` event on the `concierge.tasks` topic. */
export interface ConciergeTaskUpsertEvent {
  task: ConciergeTaskDto;
}
