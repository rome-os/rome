// Wire types of a Concierge chat's Work tab: everything that runs for the
// chat, grouped. The server is packages/core/src/concierge/work.ts and the
// clients are packages/web and the iOS app. docs/domains/work.md

import type { ChatPendingCheckDto, ConciergeFollowDto, ConciergeTaskDto } from "./concierge.js";
import { type ConciergeTaskStatus, parseTaskStatus } from "./concierge-task-status.js";

/** The groups, in the order the tab shows them. */
export const CHAT_WORK_GROUPS = ["needs_you", "active", "later", "on_its_own", "ended"] as const;
export type ChatWorkGroupKey = (typeof CHAT_WORK_GROUPS)[number];

/** A task's repeating schedule, as its row shows it. */
export interface ChatWorkSchedule {
  /** Local time in its owner's zone, `HH:mm`. */
  at: string;
  /** The weekdays it runs on (`mon` … `sun`); null for every day. */
  days: string[] | null;
}

/** A check pending on a task's row: a wake-up, or its schedule's next run. */
export interface ChatWorkTaskCheck {
  id: string;
  /** When it is due, epoch milliseconds; null for an event wait with no deadline. */
  at: number | null;
  /** The schedule's next run: cancelling it skips that one run. */
  recurring: boolean;
}

/** A task, with its schedule and its soonest check on its own row. */
export interface ChatWorkTaskItem {
  kind: "task";
  task: ConciergeTaskDto;
  schedule: ChatWorkSchedule | null;
  check: ChatWorkTaskCheck | null;
}

/** A one-off wake-up of the chat (`defer`) that no task of this chat has. */
export interface ChatWorkCheckItem {
  kind: "check";
  check: ChatPendingCheckDto;
}

/** A followed target whose alerts and digest come to this chat. */
export interface ChatWorkFollowItem {
  kind: "follow";
  /** The service, as the following list names it, such as `github`. */
  source: string;
  /** The service's name as a person reads it. */
  label: string;
  target: string;
  state: ConciergeFollowDto["state"];
  /** When its owner's digest comes each day, `HH:mm` in their zone, sorted. */
  digestTimes: string[];
}

/** What fires a routine, as its row says it. */
export type ChatWorkTrigger =
  | {
      type: "schedule";
      /** `HH:mm` in `tzid`. */
      localTime: string;
      /** The repeat rule; null for a one-off. */
      rrule: string | null;
      /** A one-off's date, `YYYY-MM-DD`; null for a repeating one. */
      date: string | null;
    }
  | { type: "event-bus"; eventName: string }
  | { type: "manual" };

/** A routine that sends into this chat, such as an older daily summary. */
export interface ChatWorkRoutineItem {
  kind: "routine";
  id: string;
  name: string;
  trigger: ChatWorkTrigger;
  /** Off while paused. */
  enabled: boolean;
  /** When it fires next, epoch milliseconds; null when it has no time. */
  nextRunAt: number | null;
  /** How its latest run ended, or null before its first. */
  lastRun: {
    status: "success" | "error" | "running" | "pending_approval" | "cancelled";
    firedAt: number;
  } | null;
  /** An app keeps it: only that app can delete it. */
  managed: boolean;
}

export type ChatWorkItem =
  | ChatWorkTaskItem
  | ChatWorkCheckItem
  | ChatWorkFollowItem
  | ChatWorkRoutineItem;

export interface ChatWorkGroup {
  key: ChatWorkGroupKey;
  items: ChatWorkItem[];
}

/** `GET /api/chats/:chatId/work`: the groups that have rows, in order. */
export interface ChatWorkResponse {
  chatId: string;
  groups: ChatWorkGroup[];
}

/** `POST /api/chats/:chatId/work/follows/unfollow`. */
export interface ChatWorkUnfollowRequest {
  source: string;
  target: string;
}

/**
 * Event on the `chat.work:<chatId>` live topic: something its Work tab lists
 * changed (a task's status, a check, a routine, a follow). Read the tab again.
 */
export const CHAT_WORK_CHANGED_EVENT = "work_changed";
export interface ChatWorkChangedEvent {
  chatId: string;
}

/** What the server gathers for one chat, before grouping. */
export interface ChatWorkParts {
  tasks: ChatWorkTaskItem[];
  checks: ChatWorkCheckItem[];
  follows: ChatWorkFollowItem[];
  routines: ChatWorkRoutineItem[];
}

const GROUP_OF_STATUS: Record<ConciergeTaskStatus, ChatWorkGroupKey> = {
  needs_you: "needs_you",
  active: "active",
  later: "later",
  ended: "ended",
};

/** Missing values sort last. */
const byNullableAsc = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;

/** When a later row runs next: its check, else the task's later time. */
const laterOf = (item: ChatWorkItem): number | null => {
  if (item.kind === "task") return item.check?.at ?? item.task.laterAt ?? null;
  if (item.kind === "check") return item.check.at;
  return null;
};

const endedAt = (task: ConciergeTaskDto) => task.completedAt ?? task.updatedAt;

const SORTERS: Record<ChatWorkGroupKey, (a: ChatWorkItem, b: ChatWorkItem) => number> = {
  // The oldest wait first: it ends soonest.
  needs_you: (a, b) =>
    a.kind === "task" && b.kind === "task"
      ? byNullableAsc(a.task.waitingSince ?? null, b.task.waitingSince ?? null)
      : 0,
  // The newest change first.
  active: (a, b) =>
    a.kind === "task" && b.kind === "task" ? b.task.updatedAt - a.task.updatedAt : 0,
  // The soonest first.
  later: (a, b) => byNullableAsc(laterOf(a), laterOf(b)),
  // Follows, then routines by their next run.
  on_its_own: (a, b) =>
    a.kind === "follow" && b.kind === "follow"
      ? `${a.label} ${a.target}`.localeCompare(`${b.label} ${b.target}`)
      : a.kind === "follow"
        ? -1
        : b.kind === "follow"
          ? 1
          : a.kind === "routine" && b.kind === "routine"
            ? byNullableAsc(a.nextRunAt, b.nextRunAt) || a.name.localeCompare(b.name)
            : 0,
  // The latest to end first.
  ended: (a, b) => (a.kind === "task" && b.kind === "task" ? endedAt(b.task) - endedAt(a.task) : 0),
};

/**
 * The rows in their groups, in order, with empty groups left out. A task is
 * in the group of its status, a check is later, and follows and routines run
 * on their own. An archived task is in none.
 */
export function groupChatWork(parts: ChatWorkParts): ChatWorkGroup[] {
  const groups = new Map<ChatWorkGroupKey, ChatWorkItem[]>();
  const add = (key: ChatWorkGroupKey, item: ChatWorkItem) =>
    groups.set(key, [...(groups.get(key) ?? []), item]);
  for (const item of parts.tasks) {
    if (item.task.archivedAt !== null) continue;
    add(GROUP_OF_STATUS[parseTaskStatus(item.task.status, item.task.endReason).status], item);
  }
  for (const item of parts.checks) add("later", item);
  for (const item of parts.follows) add("on_its_own", item);
  for (const item of parts.routines) add("on_its_own", item);
  return CHAT_WORK_GROUPS.flatMap((key) => {
    const items = groups.get(key);
    return items ? [{ key, items: [...items].sort(SORTERS[key]) }] : [];
  });
}
