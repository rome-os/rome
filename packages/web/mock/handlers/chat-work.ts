import { http, HttpResponse } from "msw";
import {
  type ChatWorkParts,
  type ChatWorkResponse,
  type ChatWorkUnfollowRequest,
  groupChatWork,
} from "@rome/api-types/chat-work";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { legacyTaskState, taskStatus } from "@rome/api-types/concierge-task-status";
import { CONCIERGE_CHAT_ID } from "@/hooks/use-concierge";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A task row as the server sends it, with the status Rome derived for it. */
function task(
  id: string,
  title: string,
  status: NonNullable<ConciergeTaskDto["status"]>,
  extra: Partial<ConciergeTaskDto> = {},
): ConciergeTaskDto {
  const now = Date.now();
  const endReason = extra.endReason ?? (status === "ended" ? "done" : null);
  return {
    id,
    title,
    state: legacyTaskState({ status, endReason }),
    status,
    endReason,
    waitingSince: null,
    openWait: null,
    laterAt: null,
    summary: null,
    waitingOn: null,
    dueAt: null,
    rank: null,
    chat: { id: `mock-task-chat-${id}`, name: title },
    threadRoot: null,
    conciergeChat: { id: CONCIERGE_CHAT_ID, name: "Main chat", main: true },
    sourceMessageId: null,
    createdAt: now - 3 * HOUR,
    updatedAt: now - 10 * MINUTE,
    completedAt: status === "ended" ? now - 2 * HOUR : null,
    archivedAt: null,
    notSynced: false,
    ...extra,
  };
}

/** The main chat's work: a row of every kind, so each group shows. Other chats have none. */
function fixture(): ChatWorkParts {
  const now = Date.now();
  return {
    tasks: [
      {
        kind: "task",
        task: task("book-flight", "Book the Lisbon flight", "needs_you", {
          waitingSince: now - 20 * MINUTE,
          openWait: { kind: "approval", id: "approval-1", since: now - 20 * MINUTE },
        }),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("pr-review", "Review the open pull requests", "active"),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("visa", "Check the visa appointment", "later", { laterAt: now + 20 * MINUTE }),
        schedule: null,
        check: { id: "check-visa", at: now + 20 * MINUTE, recurring: false },
      },
      {
        kind: "task",
        task: task("morning-brief", "Morning brief", "later", { laterAt: now + 14 * HOUR }),
        schedule: { at: "08:00", days: ["mon", "tue", "wed", "thu", "fri"] },
        check: { id: "run-morning-brief", at: now + 14 * HOUR, recurring: true },
      },
      {
        kind: "task",
        task: task("hotel", "Compare hotels near Alfama", "ended"),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("refund", "Ask for the train refund", "ended", { endReason: "no_response" }),
        schedule: null,
        check: null,
      },
    ],
    checks: [
      {
        kind: "check",
        check: {
          id: "check-package",
          name: "See if the package shipped",
          at: now + 3 * HOUR,
          waitingFor: null,
          taskId: null,
          taskTitle: null,
        },
      },
    ],
    follows: [
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "rome-os/rome",
        state: "active",
        digestTimes: ["09:00", "18:00"],
      },
    ],
    routines: [
      {
        kind: "routine",
        id: "routine-daily-summary",
        name: "Daily summary",
        trigger: { type: "schedule", localTime: "21:00", rrule: "FREQ=DAILY", date: null },
        enabled: true,
        nextRunAt: now + 6 * HOUR,
        lastRun: { status: "error", firedAt: now - 18 * HOUR },
        managed: false,
      },
    ],
  };
}

/** Each chat's work, made on first read and changed by the tab's actions. */
const stores = new Map<string, ChatWorkParts>();
const partsOf = (chatId: string): ChatWorkParts => {
  let parts = stores.get(chatId);
  if (!parts) {
    parts =
      chatId === CONCIERGE_CHAT_ID
        ? fixture()
        : { tasks: [], checks: [], follows: [], routines: [] };
    stores.set(chatId, parts);
  }
  return parts;
};

const notFound = (what: string) =>
  HttpResponse.json({ error: `No such ${what} in this chat` }, { status: 404 });

export const chatWorkHandlers = [
  http.get("/api/chats/:chatId/work", ({ params }) => {
    const chatId = String(params.chatId);
    return HttpResponse.json({
      chatId,
      groups: groupChatWork(partsOf(chatId)),
    } satisfies ChatWorkResponse);
  }),
  // Held open without events: the tab reads again after its own actions.
  http.get("/api/chats/:chatId/work/events", () => {
    const stream = new ReadableStream({ start() {} });
    return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
  }),
  http.post("/api/chats/:chatId/work/tasks/:taskId/stop", ({ params }) => {
    const item = partsOf(String(params.chatId)).tasks.find(
      (found) => found.task.id === params.taskId,
    );
    if (!item) return notFound("task");
    const now = Date.now();
    // Stopped is a fact; Rome's own rule says what status it gives.
    const stopped = taskStatus(
      {
        stoppedAt: now,
        waitingSince: null,
        running: false,
        reportPending: false,
        laterAt: null,
        lastOutcome: null,
        started: true,
      },
      now,
    );
    item.task = {
      ...item.task,
      ...stopped,
      state: legacyTaskState(stopped),
      openWait: null,
      completedAt: now,
    };
    item.check = null;
    item.schedule = null;
    return HttpResponse.json({ ok: true });
  }),
  http.delete("/api/chats/:chatId/work/checks/:checkId", ({ params }) => {
    const parts = partsOf(String(params.chatId));
    const lone = parts.checks.findIndex((found) => found.check.id === params.checkId);
    if (lone >= 0) {
      parts.checks.splice(lone, 1);
      return HttpResponse.json({ ok: true });
    }
    const item = parts.tasks.find((found) => found.check?.id === params.checkId);
    if (!item?.check) return notFound("check");
    if (item.check.recurring && item.check.at !== null) {
      // A skipped run moves the check to the run after it.
      item.check = { ...item.check, at: item.check.at + 24 * HOUR };
    } else {
      item.check = null;
      item.task = { ...item.task, laterAt: null };
    }
    return HttpResponse.json({ ok: true });
  }),
  ...(["pause", "resume"] as const).map((action) =>
    http.post(`/api/chats/:chatId/work/routines/:routineId/${action}`, ({ params }) => {
      const item = partsOf(String(params.chatId)).routines.find(
        (found) => found.id === params.routineId,
      );
      if (!item) return notFound("routine");
      item.enabled = action === "resume";
      item.nextRunAt = item.enabled ? Date.now() + 6 * HOUR : null;
      return HttpResponse.json({ ok: true });
    }),
  ),
  http.delete("/api/chats/:chatId/work/routines/:routineId", ({ params }) => {
    const parts = partsOf(String(params.chatId));
    const index = parts.routines.findIndex((found) => found.id === params.routineId);
    if (index < 0) return notFound("routine");
    parts.routines.splice(index, 1);
    return HttpResponse.json({ ok: true });
  }),
  http.post("/api/chats/:chatId/work/follows/unfollow", async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<ChatWorkUnfollowRequest>;
    const parts = partsOf(String(params.chatId));
    const index = parts.follows.findIndex(
      (found) => found.source === body.source && found.target === body.target,
    );
    if (index < 0) return notFound("follow");
    parts.follows.splice(index, 1);
    return HttpResponse.json({ ok: true });
  }),
];
