// A Concierge chat's task list, the Tasks panel: everything that runs for the
// chat, gathered from the reads that already decide it. Tasks bring their
// derived status, checks and schedules come from the routines the Concierge
// made, follows from the owner's following, and routines from their
// `chat_id`: those of the chat and those of its task chats. Nothing here
// decides a status.
// docs/domains/chats.md#task-list

import {
  type TaskListCheckItem,
  type TaskListFollowItem,
  type TaskListResponse,
  type TaskListRoutineItem,
  type TaskListTaskItem,
  type TaskListTrigger,
  groupTaskList,
  pageTaskList,
} from "@rome/api-types/task-list";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { type RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import { RESUME_SESSION_ACTION } from "../routines/defer.js";
import type { RoutineEngine } from "../routines/engine.js";
import type { Routine } from "../routines/types.js";
import { createLogger } from "../logger.js";
import { cardMessagesOf } from "./task-cards.js";
import {
  CONCIERGE_DIGEST_ACTION,
  CONCIERGE_FOLLOW_ACTION,
  type ConciergeFollowing,
} from "./following.js";
import type { TaskChecks } from "./task-checks.js";
import { CONCIERGE_TASK_RUN_ACTION, scheduleOfRoutine } from "./task-schedule.js";
import type { ConciergeOwner } from "../webchat/owner.js";

const log = createLogger("concierge-task-list");

/** Stored message times are whole seconds. */
const SAME_SECOND_MS = 1_000;

/** How long changes are gathered before the list is told, so a burst tells it once. */
const CHANGE_SETTLE_MS = 150;

/** The routines a chat's list shows apart, or never: checks, task schedules, follows and digests. */
const NOT_A_CHAT_ROUTINE = new Set([
  RESUME_SESSION_ACTION,
  `system:${RESUME_SESSION_ACTION}`,
  CONCIERGE_TASK_RUN_ACTION,
  CONCIERGE_FOLLOW_ACTION,
  CONCIERGE_DIGEST_ACTION,
]);

export interface ChatTaskListDeps {
  /** One chat's task rows of its owner, every open one and the ended ones of the last week. */
  tasks: {
    listForChatPanel(owner: ConciergeOwner, chatId: string): Promise<ConciergeTaskDto[]>;
    repo: {
      onChange(
        listener: (task: { owner: string; conciergeChat: { id: string } }) => void,
      ): () => void;
      /** Which of `chatIds` are the chat's task chats, each with its task, ended or not. */
      taskChatsAmong(
        chatIds: readonly string[],
        conciergeChatId: string,
        owner: ConciergeOwner,
      ): Promise<Array<{ chatId: string; task: { id: string; title: string } }>>;
    };
  };
  checks?: Pick<TaskChecks, "inChatForApi">;
  following?: () => Pick<ConciergeFollowing, "followsIn" | "onChange"> | null;
  routines: Pick<RoutinesRepository, "findWithChat" | "listRoutines" | "findById">;
  routineRuns: Pick<RoutineRunsRepository, "findLatestByRoutineIds">;
  routineEngine: Pick<RoutineEngine, "onChange">;
  /**
   * Calls `listener` with a chat's id when a message holding a task chat part
   * is said in it, which can move a task's Respond. Returns the unsubscribe.
   */
  onTaskCardMessage?: (listener: (chatId: string) => void) => () => void;
  /** The assistant messages of a chat that hold a task chat part, in the order said. */
  /** From `since` on, when given. */
  taskChatPartMessages: (
    chatId: string,
    since?: Date,
  ) => Promise<Array<{ id: string; content: string; createdAt: Date }>>;
}

/** A routine's trigger as its row says it. */
function triggerOf(routine: Routine): TaskListTrigger {
  const trigger = routine.trigger;
  if (trigger.type === "schedule") {
    return {
      type: "schedule",
      localTime: trigger.localTime,
      rrule: trigger.rrule?.trim() || null,
      date: trigger.date ?? null,
      tzid: trigger.tzid,
      tzMode: trigger.tzMode,
    };
  }
  if (trigger.type === "event-bus") return { type: "event-bus", eventName: trigger.eventName };
  return { type: "manual" };
}

/** A one-off that fired and has no run to come: it is spent, and shows nowhere. */
function spent(routine: Routine): boolean {
  return (
    routine.trigger.type === "schedule" &&
    Boolean(routine.trigger.date) &&
    routine.lastFiredAt !== undefined &&
    routine.nextRunAt === undefined
  );
}

export class ChatTaskList {
  constructor(private readonly deps: ChatTaskListDeps) {}

  /** Everything that runs for Concierge chat `chatId` of owner `owner`, grouped. */
  async read(
    chatId: string,
    owner: ConciergeOwner,
    page: { endedBefore?: string } = {},
  ): Promise<TaskListResponse> {
    const [mine, checks, follows, routines] = await Promise.all([
      this.deps.tasks.listForChatPanel(owner, chatId),
      this.deps.checks?.inChatForApi(chatId) ?? Promise.resolve([]),
      this.followsIn(chatId, owner),
      this.routinesIn(chatId, owner),
    ]);
    const [schedules, cards] = await Promise.all([
      this.schedulesOf(mine.map((task) => task.id)),
      this.cardMessagesOf(chatId, mine),
    ]);
    const taskIds = new Set(mine.map((task) => task.id));
    const taskItems: TaskListTaskItem[] = mine.map((task) => {
      // Checks come soonest first, so the first is the one the row shows.
      const check = checks.find((found) => found.taskId === task.id);
      return {
        kind: "task",
        task,
        schedule: schedules.get(task.id) ?? null,
        check: check ? { id: check.id, at: check.at, recurring: check.recurring === true } : null,
        cardMessageId: (task.chat && cards.get(task.chat.id)) ?? null,
      };
    });
    const checkItems: TaskListCheckItem[] = checks
      .filter((check) => !check.taskId || !taskIds.has(check.taskId))
      .map((check) => ({ kind: "check", check: { ...check, taskTitle: null } }));
    return {
      chatId,
      groups: pageTaskList(
        groupTaskList({ tasks: taskItems, checks: checkItems, follows, routines }),
        page.endedBefore,
      ),
    };
  }

  /**
   * For each task that needs its owner, the message of chat `chatId` that
   * shows the card of the wait it now holds, by its task chat. Read only
   * while one does.
   */
  private async cardMessagesOf(
    chatId: string,
    tasks: readonly ConciergeTaskDto[],
  ): Promise<Map<string, string>> {
    const waits = new Map(
      tasks.flatMap((task) =>
        task.status === "needs_you" && task.chat && task.openWait
          ? [[task.chat.id, task.openWait] as const]
          : [],
      ),
    );
    if (waits.size === 0) return new Map();
    // A card that shows a wait is said once the wait began: read from the
    // oldest one's second on, not the whole chat.
    const since = new Date(
      Math.min(...[...waits.values()].map((wait) => wait.since)) - SAME_SECOND_MS,
    );
    return cardMessagesOf(await this.deps.taskChatPartMessages(chatId, since), waits);
  }

  private async followsIn(chatId: string, owner: ConciergeOwner): Promise<TaskListFollowItem[]> {
    const following = this.deps.following?.();
    if (!following?.followsIn) return [];
    try {
      return await following.followsIn(chatId, owner);
    } catch (error) {
      // The rest of the list still shows when the follows cannot be read.
      log.warn("failed to read the follows of a chat", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async schedulesOf(
    taskIds: readonly string[],
  ): Promise<Map<string, TaskListTaskItem["schedule"]>> {
    const out = new Map<string, TaskListTaskItem["schedule"]>();
    if (taskIds.length === 0) return out;
    const wanted = new Set(taskIds);
    for (const routine of await this.deps.routines.listRoutines()) {
      if (!routine.enabled) continue;
      const schedule = scheduleOfRoutine(routine);
      if (!schedule || !wanted.has(schedule.taskId)) continue;
      out.set(schedule.taskId, { at: schedule.at, days: schedule.days ?? null });
    }
    return out;
  }

  /**
   * The routines of chat `chatId` and of its task chats. Only the chats
   * other routines work for are looked up as task chats, never the owner's
   * whole task history. A task chat's routine names its task, whoever it
   * works for.
   */
  private async routinesIn(chatId: string, owner: ConciergeOwner): Promise<TaskListRoutineItem[]> {
    const shown = (await this.deps.routines.findWithChat())
      .map((row) => ({ row, routine: toRoutine(row) }))
      .filter(({ routine }) => !NOT_A_CHAT_ROUTINE.has(routine.actionName) && !spent(routine));
    const elsewhere = shown.flatMap(({ row }) =>
      row.chatId && row.chatId !== chatId ? [row.chatId] : [],
    );
    const taskChats = new Map(
      (await this.deps.tasks.repo.taskChatsAmong(elsewhere, chatId, owner)).map(
        (taskChat) => [taskChat.chatId, taskChat.task] as const,
      ),
    );
    const fromTask = new Map<string, { id: string; title: string }>();
    const routines = shown.flatMap(({ row, routine }) => {
      if (row.chatId === chatId) return [routine];
      const task = taskChats.get(row.chatId ?? "");
      if (!task) return [];
      fromTask.set(routine.id, task);
      return [routine];
    });
    const latest = await this.deps.routineRuns.findLatestByRoutineIds(
      routines.map((routine) => routine.id),
    );
    return routines.map((routine) => {
      const run = latest.get(routine.id);
      return {
        kind: "routine",
        id: routine.id,
        name: routine.name,
        trigger: triggerOf(routine),
        enabled: routine.enabled,
        nextRunAt: routine.enabled ? (routine.nextRunAt?.getTime() ?? null) : null,
        lastRun: run ? { status: run.status, firedAt: run.firedAt.getTime() } : null,
        createdAt: routine.createdAt.getTime(),
        ...(fromTask.has(routine.id) ? { fromTask: fromTask.get(routine.id) } : {}),
      };
    });
  }

  /**
   * Calls `changed` whenever something chat `chatId`'s list holds may have
   * changed: one of its owner's tasks, a routine of the chat or of one of
   * its task chats, one that is a check or a schedule, or a follow. A burst
   * calls it once, saying whether a follow was among what changed. Returns
   * the unsubscribe.
   */
  watch(
    chatId: string,
    owner: ConciergeOwner,
    changed: (what: { follows: boolean }) => void,
  ): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let follows = false;
    const tell = () => {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        const what = { follows };
        follows = false;
        if (!closed) changed(what);
      }, CHANGE_SETTLE_MS);
    };
    const stops = [
      this.deps.tasks.repo.onChange((task) => {
        if (task.owner === owner) tell();
      }),
      this.deps.routineEngine.onChange((routineId) => {
        void this.deps.routines
          .findById(routineId)
          .then(async (row) => {
            // A deleted routine may have been this chat's: tell it.
            if (!row) return tell();
            const routine = toRoutine(row);
            if (this.concerns(routine, row.chatId, chatId)) return tell();
            if (row.chatId && !NOT_A_CHAT_ROUTINE.has(routine.actionName)) {
              const taskChats = await this.deps.tasks.repo.taskChatsAmong(
                [row.chatId],
                chatId,
                owner,
              );
              if (taskChats.length > 0) tell();
            }
          })
          .catch(() => tell());
      }),
      this.deps.following?.()?.onChange?.(() => {
        follows = true;
        tell();
      }) ?? (() => {}),
      // A new card may be the one a waiting task's Respond goes to now.
      this.deps.onTaskCardMessage?.((cardChat) => {
        if (cardChat === chatId) tell();
      }) ?? (() => {}),
    ];
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }

  /** Whether a change of `routine` may change chat `chatId`'s list. */
  private concerns(routine: Routine, routineChat: string | null, chatId: string): boolean {
    if (routine.actionName === CONCIERGE_TASK_RUN_ACTION) return true;
    if (routine.actionName === RESUME_SESSION_ACTION) {
      return (routine.args as Record<string, unknown>).threadId === chatId;
    }
    return routineChat === chatId && !NOT_A_CHAT_ROUTINE.has(routine.actionName);
  }
}
