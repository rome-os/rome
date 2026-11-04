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

/** Where a followed item lives. */
export const CONCIERGE_FOLLOW_SOURCES = ["github", "gmail"] as const;
export type ConciergeFollowSource = (typeof CONCIERGE_FOLLOW_SOURCES)[number];

/** The kinds of event each source can tell the guardian about. */
export const CONCIERGE_FOLLOW_KINDS = {
  /** By GitHub's event name. */
  github: [
    "pull_request",
    "pull_request_review",
    "issue_comment",
    "pull_request_review_comment",
    "workflow_run",
  ],
  gmail: ["new_mail"],
} as const satisfies Record<ConciergeFollowSource, readonly string[]>;
export type ConciergeFollowKind<S extends ConciergeFollowSource = ConciergeFollowSource> =
  (typeof CONCIERGE_FOLLOW_KINDS)[S][number];

/** A daily window in the guardian's timezone, `HH:mm` to `HH:mm`; it may wrap midnight. */
export interface ConciergeQuietHours {
  start: string;
  end: string;
}

/** How often events from what the Concierge follows may wake it, across every source. */
export interface ConciergeFollowRules {
  maxTurnsPerHour: number;
  minSpacingMinutes: number;
  /** Off when null. */
  quietHours: ConciergeQuietHours | null;
}

export const CONCIERGE_FOLLOW_DEFAULT_RULES: ConciergeFollowRules = {
  maxTurnsPerHour: 2,
  minSpacingMinutes: 15,
  quietHours: null,
};
export const CONCIERGE_FOLLOW_MAX_TURNS_PER_HOUR = 12;
export const CONCIERGE_FOLLOW_MAX_SPACING_MINUTES = 120;

/** One thing the Concierge follows: a GitHub repo, a mailbox. */
export interface ConciergeFollowedItemDto {
  source: ConciergeFollowSource;
  /** What is followed at the source: `owner/repo`, a mailbox address. */
  target: string;
  /** Who the events are judged for: the guardian's GitHub login, their address. */
  account: string;
  kinds: { kind: ConciergeFollowKind; enabled: boolean }[];
}

/** `GET /concierge/following`. */
export interface ConciergeFollowingResponse {
  items: ConciergeFollowedItemDto[];
  rules: ConciergeFollowRules;
}
