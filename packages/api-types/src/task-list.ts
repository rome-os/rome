// Wire types of a Concierge chat's task list, the Tasks panel: everything
// that runs for the chat, grouped. The server is
// packages/core/src/concierge/task-list.ts and the clients are packages/web
// and the iOS app. docs/domains/chats.md#task-list

import type { ChatPendingCheckDto, ConciergeFollowDto, ConciergeTaskDto } from "./concierge.js";
import { type ConciergeTaskStatus, parseTaskStatus } from "./concierge-task-status.js";

/** The groups, in the order the panel shows them. */
export const TASK_LIST_GROUPS = ["needs_you", "active", "later", "on_its_own", "ended"] as const;
export type TaskListGroupKey = (typeof TASK_LIST_GROUPS)[number];

/** A task's repeating schedule, as its row shows it. */
export interface TaskListSchedule {
  /** Local time in its owner's zone, `HH:mm`. */
  at: string;
  /** The weekdays it runs on (`mon` … `sun`); null for every day. */
  days: string[] | null;
}

/** A check pending on a task's row: a wake-up, or its schedule's next run. */
export interface TaskListTaskCheck {
  id: string;
  /** When it is due, epoch milliseconds; null for an event wait with no deadline. */
  at: number | null;
  /** The schedule's next run, not a wake-up. */
  recurring: boolean;
}

/** A task, with its schedule and its soonest check on its own row. */
export interface TaskListTaskItem {
  kind: "task";
  task: ConciergeTaskDto;
  schedule: TaskListSchedule | null;
  check: TaskListTaskCheck | null;
  /**
   * While it needs its owner: the message of this Concierge chat that shows
   * the question or approval card it now waits on, where Respond goes. Null
   * when no message of this chat shows it, where Respond opens its task
   * chat, and for any other status.
   */
  cardMessageId: string | null;
}

/** A one-off wake-up of the chat (`defer`) that no task of this chat has. */
export interface TaskListCheckItem {
  kind: "check";
  check: ChatPendingCheckDto;
}

/** A followed target whose alerts and digest come to this chat. */
export interface TaskListFollowItem {
  kind: "follow";
  /** The service, as the following list names it, such as `github`. */
  source: string;
  /** The service's name as a person reads it. */
  label: string;
  target: string;
  /**
   * From the stored follow only: `off` when every kind is off, else `active`.
   * The list no longer says `unavailable`; whether the source is ready now is
   * in `GET /concierge/connectors`.
   */
  state: ConciergeFollowDto["state"];
  /** When its owner's digest comes each day, `HH:mm` in their zone, sorted. */
  digestTimes: string[];
  /** When it was followed, epoch milliseconds. Absent on follows made before it was kept. */
  createdAt?: number;
}

/** What fires a routine, as its row says it. */
export type TaskListTrigger =
  | {
      type: "schedule";
      /** `HH:mm` in `tzid`. */
      localTime: string;
      /** The repeat rule; null for a one-off. */
      rrule: string | null;
      /** A one-off's date, `YYYY-MM-DD`; null for a repeating one. */
      date: string | null;
      /** The IANA zone `localTime` is in. */
      tzid?: string;
      /**
       * `fixed` runs in `tzid`; `floating` runs in the owner's current zone,
       * so its `tzid` is only the zone it was made in.
       */
      tzMode?: "fixed" | "floating";
    }
  | { type: "event-bus"; eventName: string }
  | { type: "manual" };

/**
 * A routine that works for this chat, such as an older daily summary: one
 * that sends into it or was made in it, or one that works for one of its
 * task chats.
 */
export interface TaskListRoutineItem {
  kind: "routine";
  id: string;
  name: string;
  trigger: TaskListTrigger;
  /** Off while paused. */
  enabled: boolean;
  /** When it fires next, epoch milliseconds; null when it has no time. */
  nextRunAt: number | null;
  /** How its latest run ended, or null before its first. */
  lastRun: {
    status: "success" | "error" | "running" | "pending_approval" | "cancelled";
    firedAt: number;
  } | null;
  /** When it was made, epoch milliseconds. */
  createdAt?: number;
  /**
   * The task whose task chat the routine works for, ended or not, when it
   * shows here through that task chat. Absent for the chat's own routines.
   */
  fromTask?: { id: string; title: string };
}

export type TaskListItem =
  | TaskListTaskItem
  | TaskListCheckItem
  | TaskListFollowItem
  | TaskListRoutineItem;

export interface TaskListGroup {
  key: TaskListGroupKey;
  items: TaskListItem[];
  /** Ended only: how many ended rows there are in all, of which `items` is one page. */
  total?: number;
  /** Ended only: the cursor of the next page (`?endedBefore=`), or null after the last. */
  nextCursor?: string | null;
}

/**
 * `GET /api/chats/:chatId/tasks`: the groups that have rows, in order. Ended
 * holds its newest {@link TASK_LIST_ENDED_PAGE} rows; `?endedBefore=<cursor>`
 * answers the ended group alone, its next page from that cursor.
 */
export interface TaskListResponse {
  chatId: string;
  groups: TaskListGroup[];
}

/**
 * Event on the `chat.tasks:<chatId>` live topic: something its task list holds
 * changed (a task's status, a check, a routine, a follow). Read the list again.
 */
export const TASK_LIST_CHANGED_EVENT = "tasks_changed";
export interface TaskListChangedEvent {
  chatId: string;
  /** Present when a follow was among what changed, so a client reads the follows' sources again. */
  follows?: true;
}

/** What the server gathers for one chat, before grouping. */
export interface TaskListParts {
  tasks: TaskListTaskItem[];
  checks: TaskListCheckItem[];
  follows: TaskListFollowItem[];
  routines: TaskListRoutineItem[];
}

const GROUP_OF_STATUS: Record<ConciergeTaskStatus, TaskListGroupKey> = {
  needs_you: "needs_you",
  active: "active",
  later: "later",
  ended: "ended",
};

/** Missing values sort last. */
const byNullableAsc = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;

/** When a later row runs next: its check, else the task's later time. */
const laterOf = (item: TaskListItem): number | null => {
  if (item.kind === "task") return item.check?.at ?? item.task.laterAt ?? null;
  if (item.kind === "check") return item.check.at;
  return null;
};

const endedAt = (task: ConciergeTaskDto) => task.completedAt ?? task.updatedAt;

const SORTERS: Record<TaskListGroupKey, (a: TaskListItem, b: TaskListItem) => number> = {
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
  // The latest to end first; one id before another when both ended at once.
  ended: (a, b) =>
    a.kind === "task" && b.kind === "task"
      ? endedAt(b.task) - endedAt(a.task) || a.task.id.localeCompare(b.task.id)
      : 0,
};

/** How many ended rows a read of the task list holds, and each "Show more" adds. */
export const TASK_LIST_ENDED_PAGE = 20;

const cursorOf = (item: TaskListItem): string =>
  item.kind === "task" ? `${endedAt(item.task)}_${item.task.id}` : "";

/** Whether ended row `item` comes after `cursor` in the ended group's order. */
function afterCursor(item: TaskListItem, cursor: string): boolean {
  if (item.kind !== "task") return false;
  const split = cursor.indexOf("_");
  const at = Number(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  const ended = endedAt(item.task);
  return ended < at || (ended === at && item.task.id.localeCompare(id) > 0);
}

/**
 * The groups as one read answers them: the ended group cut to one page, with
 * its total and the next page's cursor. From `endedBefore` on, the ended
 * group's page from that cursor alone.
 */
export function pageTaskList(groups: TaskListGroup[], endedBefore?: string): TaskListGroup[] {
  const ended = groups.find((group) => group.key === "ended");
  if (endedBefore !== undefined) {
    if (!ended) return [];
    const rest = ended.items.filter((item) => afterCursor(item, endedBefore));
    const items = rest.slice(0, TASK_LIST_ENDED_PAGE);
    return [
      {
        key: "ended",
        items,
        total: ended.items.length,
        nextCursor: rest.length > items.length ? cursorOf(items.at(-1)!) : null,
      },
    ];
  }
  return groups.map((group) => {
    if (group.key !== "ended") return group;
    const items = group.items.slice(0, TASK_LIST_ENDED_PAGE);
    return {
      key: "ended",
      items,
      total: group.items.length,
      nextCursor: group.items.length > items.length ? cursorOf(items.at(-1)!) : null,
    };
  });
}

/**
 * The rows in their groups, in order, with empty groups left out. A task is
 * in the group of its status, a check is later, and follows and routines run
 * on their own. An archived task is in none.
 */
export function groupTaskList(parts: TaskListParts): TaskListGroup[] {
  const groups = new Map<TaskListGroupKey, TaskListItem[]>();
  const add = (key: TaskListGroupKey, item: TaskListItem) =>
    groups.set(key, [...(groups.get(key) ?? []), item]);
  for (const item of parts.tasks) {
    if (item.task.archivedAt !== null) continue;
    add(GROUP_OF_STATUS[parseTaskStatus(item.task.status, item.task.endReason).status], item);
  }
  for (const item of parts.checks) add("later", item);
  for (const item of parts.follows) add("on_its_own", item);
  for (const item of parts.routines) add("on_its_own", item);
  return TASK_LIST_GROUPS.flatMap((key) => {
    const items = groups.get(key);
    return items ? [{ key, items: [...items].sort(SORTERS[key]) }] : [];
  });
}
