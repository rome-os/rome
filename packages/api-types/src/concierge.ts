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
/** The longest free-text preference a follow keeps. */
export const CONCIERGE_FOLLOW_PREFERENCE_MAX_LENGTH = 500;

/**
 * Whether a source can be followed now. The connection that owns the source
 * decides it; `statusReason` says what is missing and how to fix it.
 */
export type ConciergeFollowSourceStatus =
  | "ready"
  | "not_connected"
  | "no_relay"
  | "not_supported"
  | "error";

/** One kind of event a source can tell of, in the guardian's words. */
export interface ConciergeFollowKindDto {
  kind: string;
  label: string;
  /** On when a follow names no kinds. */
  default: boolean;
  /** The kind applies only while an option has this value. */
  requires?: { option: string; value: string };
}

/** One option that tunes a follow, run in code when an event is judged. */
export interface ConciergeFollowOptionDto {
  key: string;
  label: string;
  type: "enum" | "boolean" | "list";
  values?: { value: string; label: string }[];
  default: string | boolean | string[];
  itemHint?: string;
}

/** One thing the Concierge follows at a source, with its settings as they are now. */
export interface ConciergeFollowDto {
  target: string;
  /** `active`, `off` when every kind is off, or `unavailable` while its source is not ready. */
  state: "active" | "off" | "unavailable";
  kinds: { kind: string; on: boolean }[];
  /** Every option of the source, with the value the follow uses. */
  options: Record<string, string | boolean | string[]>;
  /** The guardian's own words on what matters, read when an event is judged. */
  preference: string | null;
}

/** One source, what it offers, and what is followed there. */
export interface ConciergeFollowSourceDto {
  source: string;
  label: string;
  status: ConciergeFollowSourceStatus;
  statusReason?: string;
  /** Who events are judged for: the GitHub login, the mailbox address. */
  account?: string;
  /** What a follow names, or null: the connected account itself. */
  target: { format: string; example: string } | null;
  kinds: ConciergeFollowKindDto[];
  options: ConciergeFollowOptionDto[];
  follows: ConciergeFollowDto[];
}

/**
 * `GET /concierge/following`, and what the Concierge's following list returns:
 * one structure for the panel and the agent.
 */
export interface ConciergeFollowingResponse {
  sources: ConciergeFollowSourceDto[];
  rules: ConciergeFollowRules;
}

/** A change to one follow: kinds on or off by name, options by key, the preference. */
export interface ConciergeFollowChange {
  source: string;
  target?: string;
  kinds?: Record<string, boolean>;
  options?: Record<string, unknown>;
  /** Null clears it. */
  preference?: string | null;
}
