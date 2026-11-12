// Wire types of the Concierge task panel, the assistant's own todo list. The
// server is packages/core/src/concierge and the client is packages/web.

import type { ConciergeActivity } from "./concierge-activity.js";
import type { ConciergeTaskEndReason, ConciergeTaskStatus } from "./concierge-task-status.js";

/**
 * What a task row is doing, as apps from before derived status read it. Rome
 * maps it from the task's status (`legacyTaskState`); read `status` instead.
 */
export const CONCIERGE_TASK_STATES = [
  "next",
  "doing",
  "watching",
  "needs_user",
  "done",
  "dropped",
] as const;
export type ConciergeTaskState = (typeof CONCIERGE_TASK_STATES)[number];

/**
 * How the work a guardian message started stands, as its status reaction in a
 * Concierge chat shows it (docs/domains/chats.md#status-reaction): working,
 * or failed. Work that finished shows none, since the reply says so. Rome
 * sets it, never the Concierge.
 */
export const CONCIERGE_STATUS_REACTIONS = ["working", "failed"] as const;
export type ConciergeStatusReaction = (typeof CONCIERGE_STATUS_REACTIONS)[number];

/** A message's status reaction changed (`message_status_reaction`). Null: it has none. */
export interface MessageStatusReactionEvent {
  sessionId: string;
  messageId: string;
  statusReaction: ConciergeStatusReaction | null;
}

/** The panel actions. Each one sends the Concierge a message, and never writes the row. */
export type ConciergeTaskAction = "stop" | "archive" | "done";

/** The guardian's main Concierge chat has a fixed id, and the dashboard opens it at `/message`. */
export const CONCIERGE_CHAT_ID = "concierge";

/** The Concierge chat something reports to, as a list shows it. */
export interface ConciergeChatRef {
  id: string;
  name: string;
  main: boolean;
}

/** A Concierge chat: the main chat, or a topic chat its owner started. */
export interface ConciergeChatDto extends ConciergeChatRef {
  /** Agent messages since the guardian last read the chat, at most the server's cap. */
  unread: number;
  /**
   * What the chat is doing now, as the `concierge.activity` live-events topic
   * says it, so a fresh load starts right. Absent from servers before it.
   */
  activity?: ConciergeActivity;
}

/** `GET /api/concierge/chats`: the main chat first, then the topic chats, oldest first. */
export interface ConciergeChatsResponse {
  chats: ConciergeChatDto[];
}

/** `POST /api/concierge/chats`. Without a name the chat is untitled until its first message names it. */
export interface ConciergeChatStartRequest {
  name?: string;
}

/** How many days of finished rows `GET /concierge/tasks` returns by default. */
export const CONCIERGE_DONE_DAYS = 7;

/** The longest `summary` the Concierge writes. */
export const CONCIERGE_TASK_SUMMARY_MAX_LENGTH = 120;

/** One row of the task panel. Times are epoch milliseconds. */
export interface ConciergeTaskDto {
  id: string;
  title: string;
  /** Mapped from `status` for apps from before it. */
  state: ConciergeTaskState;
  /**
   * How the task stands, derived by Rome (`taskStatus` in
   * concierge-task-status.ts). Read it with `parseTaskStatus`. Absent from
   * servers before it.
   */
  status?: ConciergeTaskStatus;
  /** Why an ended task ended; null while it has not. */
  endReason?: ConciergeTaskEndReason | null;
  /** When the wait on its owner began, while one is open in its task chat, epoch milliseconds. */
  waitingSince?: number | null;
  /** When the check scheduled for it is due, while one is pending, epoch milliseconds. */
  laterAt?: number | null;
  summary: string | null;
  waitingOn: string | null;
  dueAt: number | null;
  rank: number | null;
  /** The linked task chat, with its current name, or null when the row has none. */
  chat: { id: string; name: string } | null;
  /** The id of the first message of the task's chat thread in its Concierge chat, or null. */
  threadRoot?: string | null;
  /** The Concierge chat the row came from; its results and the panel's buttons go there. */
  conciergeChat: ConciergeChatRef;
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

/**
 * A wake-up pending in a chat: a check the agent scheduled with `defer`,
 * which the chat shows until it fires and its owner can cancel there. Times
 * are epoch milliseconds.
 */
export interface ChatPendingCheckDto {
  id: string;
  name: string;
  /** When it wakes the chat: its time, or the deadline of the event it waits for; null for an event wait with no deadline. */
  at: number | null;
  /** What an event wait waits for; null for a timed check. */
  waitingFor: string | null;
  /** The task it is for, or null. */
  taskId: string | null;
  /** That task's title, or null. */
  taskTitle?: string | null;
  /** The next run of the task's repeating schedule: cancelling it skips that run only. */
  recurring?: boolean;
}

/** `GET /chat/sessions/:id/checks`, the soonest first. */
export interface ChatPendingChecksResponse {
  checks: ChatPendingCheckDto[];
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

/**
 * The guardian's rules for what the Concierge follows, across every source:
 * when the digest of less urgent events comes, and an optional quiet window.
 * How events are batched, and the cap on urgent turns, are fixed in code.
 */
export interface ConciergeFollowRules {
  /** When the digest goes to the Concierge each day, `HH:mm` in the guardian's timezone, sorted. */
  digestTimes: string[];
  /** Urgent events wait until it ends. Off when null. */
  quietHours: ConciergeQuietHours | null;
}

export const CONCIERGE_FOLLOW_DEFAULT_RULES: ConciergeFollowRules = {
  digestTimes: ["09:00", "18:00"],
  quietHours: null,
};
/** The most digest times a day. */
export const CONCIERGE_FOLLOW_MAX_DIGEST_TIMES = 6;
/** The longest free-text preference a follow keeps. */
export const CONCIERGE_FOLLOW_PREFERENCE_MAX_LENGTH = 500;

/**
 * What a service lets Rome do, by capability, in the words of Rome's
 * connection model (`GET /api/connections`): unlocked (possibly degraded,
 * with the reason), needing access, needing a subscription, or unsupported.
 */
export type ConciergeCapabilityStatus =
  | { state: "unlocked"; degradation?: { reason: string; retryAt?: string } }
  | { state: "needs-auth"; missingGrants: string[] }
  | { state: "needs-subscription" }
  | { state: "unsupported" };

/**
 * How a client starts connecting a service. `rome_oauth`: open `url`, Rome
 * Cloud's sign-in for the service. `composio`: one call on this Rome that
 * answers `{ redirectUrl }`, after signing in to Composio when `needsLogin`.
 * `dashboard`: the dashboard's Connections page is the only way in.
 */
export type ConciergeConnectEntry =
  | { kind: "rome_oauth"; url: string | null; available: boolean; unavailableReason: string | null }
  | {
      kind: "composio";
      method: "POST";
      path: string;
      body: { provider: string };
      needsLogin: boolean;
      login: { method: "POST"; path: string };
    }
  | { kind: "dashboard" };

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
  /**
   * `active`, `off` when every kind is off, or `unavailable` while its source
   * is not ready or a kind on is not delivered.
   */
  state: "active" | "off" | "unavailable";
  /** Which kinds on are not delivered and what to do, when that makes it unavailable. */
  reason?: string;
  kinds: { kind: string; on: boolean }[];
  /** Every option of the source, with the value the follow uses. */
  options: Record<string, string | boolean | string[]>;
  /** The guardian's own words on what matters, read when an event is judged. */
  preference: string | null;
  /** The Concierge chat its alerts go to. */
  chat: ConciergeChatRef;
}

/**
 * The watch capability of a service, filled by the app that provides watch for
 * it: its status, and when it can be watched, the target format, the kinds
 * and options, and what the Concierge follows there.
 */
export type ConciergeWatchCapability = ConciergeCapabilityStatus & {
  /** Who events are judged for: the GitHub login, the mailbox address. */
  account?: string;
  /** What a follow names, or null: the connected account itself. */
  target?: { format: string; example: string } | null;
  kinds?: ConciergeFollowKindDto[];
  options?: ConciergeFollowOptionDto[];
  follows?: ConciergeFollowDto[];
};

/** One service: one of Rome's connections, or a service the connector app connects through Composio. */
export interface ConciergeConnectorDto {
  /** The connection kind (such as `github`, `telegram_user`) or the Composio toolkit (such as `gmail`). */
  service: string;
  /** The service's name as a person reads it, such as `GitHub`. */
  label: string;
  /**
   * The id of the service's mark, from whatever provides the service:
   * `brand:<connection kind>` for one of Rome's own connections, `glyph:<id>`
   * for a service its provider draws with a glyph. Null when the provider
   * names none; a client then shows a neutral tile.
   */
  icon: string | null;
  origin: "connection" | "composio";
  /** The connection's id, or null for a Composio service or a kind never connected. */
  connectionId: string | null;
  /** `working`, `broken`, or null when not connected. */
  state: "working" | "broken" | null;
  /** The account it reaches, as a person reads it, when connected. */
  account: string | null;
  /** How a client starts connecting it, when it is not working. */
  connect: ConciergeConnectEntry | null;
  capabilities: {
    chat: ConciergeCapabilityStatus;
    act: ConciergeCapabilityStatus;
    watch: ConciergeWatchCapability;
  };
}

/**
 * `GET /api/concierge/connectors`, and what the Concierge's following list
 * returns: one structure for every client and the agent. Which connectors are
 * listed is decided here, not by the client.
 */
export interface ConciergeConnectorsResponse {
  connectors: ConciergeConnectorDto[];
  rules: ConciergeFollowRules;
}

/** A change to one follow: kinds on or off by name, options by key, the preference. */
export interface ConciergeFollowChange {
  /** The service, as the list names it. */
  source: string;
  target?: string;
  kinds?: Record<string, boolean>;
  options?: Record<string, unknown>;
  /** Null clears it. */
  preference?: string | null;
  /**
   * The Concierge chat its alerts go to. Left out, a new follow reports to the
   * chat that asked, and one that exists keeps its chat.
   */
  chatId?: string;
}
