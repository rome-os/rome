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
export type ConciergeTaskAction = "stop" | "archive" | "done";

/** The Concierge's chat has a fixed id, so the dashboard opens it at `/chat/concierge`. */
export const CONCIERGE_CHAT_ID = "concierge";

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
  /**
   * The Concierge chat message this row points back to, or null when the row has
   * none or the message is gone. An id only: the text lives in the chat.
   */
  sourceMessageId: string | null;
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

/** The GitHub event kinds an alert watch covers, by GitHub's event name. */
export const CONCIERGE_ALERT_KINDS = [
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "pull_request_review_comment",
  "workflow_run",
] as const;
export type ConciergeAlertKind = (typeof CONCIERGE_ALERT_KINDS)[number];

/** A daily window in the guardian's timezone, `HH:mm` to `HH:mm`; it may wrap midnight. */
export interface ConciergeQuietHours {
  start: string;
  end: string;
}

/** How often outside events may wake the Concierge. */
export interface ConciergeAlertRules {
  maxTurnsPerHour: number;
  minSpacingMinutes: number;
  /** Off when null. */
  quietHours: ConciergeQuietHours | null;
}

export const CONCIERGE_ALERT_DEFAULT_RULES: ConciergeAlertRules = {
  maxTurnsPerHour: 2,
  minSpacingMinutes: 15,
  quietHours: null,
};
export const CONCIERGE_ALERT_MAX_TURNS_PER_HOUR = 12;
export const CONCIERGE_ALERT_MAX_SPACING_MINUTES = 120;

/** One watched repo with its event kinds. */
export interface ConciergeAlertRepoDto {
  repo: string;
  /** The GitHub login the alerts are judged against. */
  login: string;
  kinds: { kind: ConciergeAlertKind; enabled: boolean }[];
}

/** `GET /concierge/alerts`. */
export interface ConciergeAlertsResponse {
  repos: ConciergeAlertRepoDto[];
  rules: ConciergeAlertRules;
}
