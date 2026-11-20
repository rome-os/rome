import {
  TASK_LIST_CHANGED_EVENT,
  TASK_LIST_PANEL_GROUPING,
  type TaskListChangedEvent,
  type TaskLinksResponse,
  type TaskListResponse,
} from "@rome/api-types/task-list";
import type { Context } from "hono";
import { Hono } from "hono";
import { ChatTaskList } from "../../concierge/task-list.js";
import { toRoutine } from "../../db/repositories/routines.js";
import type { ConciergeService } from "../../concierge/service.js";
import type { LiveEventEmit } from "../../lib/live-event.js";
import type { ApiDeps } from "../deps.js";
import { conciergeCallerOwner, streamEvents } from "./concierge.js";
import { datedOneOffState } from "./routines.js";

type TaskListApiDeps = Pick<
  ApiDeps,
  "concierge" | "dashboardAccessState" | "routinesRepo" | "routineRunsRepo" | "routineEngine"
>;

const lists = new WeakMap<ConciergeService, ChatTaskList>();

/** The task list reader over `deps`, one per Concierge service. Null without the Concierge. */
export function chatTaskListOf(deps: TaskListApiDeps): ChatTaskList | null {
  const concierge = deps.concierge;
  if (!concierge) return null;
  let list = lists.get(concierge);
  if (!list) {
    list = new ChatTaskList({
      tasks: concierge.deps.tasks,
      checks: concierge.deps.checks,
      following: () => {
        try {
          return concierge.following;
        } catch {
          // Following is attached after boot; until then there is none.
          return null;
        }
      },
      routines: deps.routinesRepo,
      routineRuns: deps.routineRunsRepo,
      routineEngine: deps.routineEngine,
    });
    lists.set(concierge, list);
  }
  return list;
}

/**
 * Whether Concierge chat `chatId` is `owner`'s and not archived: only its
 * owner reaches its task list, and to anyone else it does not exist.
 */
export async function ownsConciergeChat(
  concierge: ConciergeService,
  chatId: string,
  owner: string,
): Promise<boolean> {
  return (
    (await concierge.conciergeChat(chatId)) !== null &&
    (await concierge.ownerOfChat(chatId)) === owner
  );
}

/** Emits `tasks_changed` whenever chat `chatId`'s task list may have changed. */
export function subscribeChatTasks(
  deps: TaskListApiDeps,
  chatId: string,
  owner: string,
  emit: LiveEventEmit,
): () => void {
  const list = chatTaskListOf(deps);
  if (!list) return () => {};
  return list.watch(chatId, owner, ({ follows }) =>
    emit(TASK_LIST_CHANGED_EVENT, {
      chatId,
      ...(follows ? { follows: true } : {}),
    } satisfies TaskListChangedEvent),
  );
}

/**
 * A Concierge chat's task list: its task chats and what runs for it on its
 * own, and the actions of its rows: Stop a task chat at work, cancel a
 * reminder, unfollow, and pause, resume or delete a routine. Every route is
 * its owner's only: another caller's chat, or an archived one, is not found,
 * and an action reaches only a row the chat's list shows.
 * docs/domains/chats.md#task-list
 */
export function chatTaskListRoutes(deps: TaskListApiDeps): Hono {
  const app = new Hono();

  /** The chat's owner and the Concierge, or the response that refuses the caller. */
  const gate = async (
    c: Context,
  ): Promise<
    { concierge: ConciergeService; list: ChatTaskList; chatId: string; owner: string } | Response
  > => {
    const owner = await conciergeCallerOwner(deps.dashboardAccessState);
    if (!owner) return c.json({ error: "Not authenticated" }, 401);
    const concierge = deps.concierge;
    const list = chatTaskListOf(deps);
    if (!concierge || !list) return c.json({ error: "Concierge is not available" }, 404);
    const chatId = c.req.param("chatId") ?? "";
    if (!(await ownsConciergeChat(concierge, chatId, owner))) {
      return c.json({ error: "No such Concierge chat" }, 404);
    }
    return { concierge, list, chatId, owner };
  };

  app.get("/chats/:chatId/tasks", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const endedBefore = c.req.query("endedBefore") || undefined;
    const grouping = c.req.query("grouping") === TASK_LIST_PANEL_GROUPING ? "panel" : "views";
    return c.json(
      (await at.list.read(at.chatId, at.owner, {
        endedBefore,
        grouping,
      })) satisfies TaskListResponse,
    );
  });

  // The same `tasks_changed` events as the `chat.tasks:<chatId>` topic of the
  // live events socket, for a tab that cannot open the socket.
  app.get("/chats/:chatId/tasks/events", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    return streamEvents(c, (emit) => subscribeChatTasks(deps, at.chatId, at.owner, emit));
  });

  // The task chats among `ids` of this chat's owner, from any of their
  // Concierge chats, as a task link draws them.
  app.get("/chats/:chatId/task-links", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const ids = [
      ...new Set(
        (c.req.query("ids") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ].slice(0, 100);
    const { tasks } = at.concierge.deps;
    const found = (await Promise.all(ids.map((id) => tasks.repo.getWithChat(id)))).flatMap(
      (task) => (task && task.owner === at.owner ? [task] : []),
    );
    const status = await tasks.statusOf(found.map((task) => task.row));
    return c.json({
      tasks: found.flatMap((task) => {
        const of = status.get(task.row.id);
        return of
          ? [{ id: task.chat.id, name: task.chat.name, status: of.status, endReason: of.endReason }]
          : [];
      }),
    } satisfies TaskLinksResponse);
  });

  // Stops one of the chat's tasks at once, as its row's Stop does.
  app.post("/chats/:chatId/tasks/:taskId/stop", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const taskId = c.req.param("taskId");
    const found = await at.concierge.deps.tasks.repo.getWithChat(taskId);
    if (!found || found.owner !== at.owner || found.conciergeChat.id !== at.chatId) {
      return c.json({ error: "No such task in this chat" }, 404);
    }
    await at.concierge.stopTask(taskId, "guardian");
    return c.json({ ok: true });
  });

  // Marks a one-off task of the chat done, as its row's status mark does on
  // hover. A scheduled task and an ended one are not marked.
  app.post("/chats/:chatId/tasks/:taskId/done", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const taskId = c.req.param("taskId");
    const { tasks } = await at.list.parts(at.chatId, at.owner);
    const item = tasks.find((found) => found.task.id === taskId);
    if (!item) return c.json({ error: "No such task in this chat" }, 404);
    if (item.schedule !== null || item.task.status === "ended") {
      return c.json({ error: "Only a one-off task that has not ended can be marked done" }, 409);
    }
    if (!(await at.concierge.markTaskDone(taskId))) {
      return c.json({ error: "This task has already ended" }, 409);
    }
    return c.json({ ok: true });
  });

  // Cancels a reminder of the chat that no task of it has, as its row's Cancel does.
  app.post("/chats/:chatId/tasks/checks/:checkId/cancel", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const checkId = c.req.param("checkId");
    const { checks } = await at.list.parts(at.chatId, at.owner);
    if (!checks.some((item) => item.check.id === checkId)) {
      return c.json({ error: "No such reminder in this chat" }, 404);
    }
    if (!(await at.concierge.cancelCheckByOwner(at.chatId, checkId))) {
      return c.json({ error: "No such reminder in this chat" }, 404);
    }
    return c.json({ ok: true });
  });

  // Unfollows a target whose alerts come to the chat, as its row's Unfollow does.
  app.post("/chats/:chatId/tasks/follows/unfollow", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const body = (await c.req.json<unknown>().catch(() => null)) as {
      source?: unknown;
      target?: unknown;
    } | null;
    const source = typeof body?.source === "string" ? body.source : null;
    const target = typeof body?.target === "string" ? body.target : null;
    if (source === null || target === null) {
      return c.json({ error: "source and target must be strings" }, 400);
    }
    const { follows } = await at.list.parts(at.chatId, at.owner);
    if (!follows.some((item) => item.source === source && item.target === target)) {
      return c.json({ error: "No such follow in this chat" }, 404);
    }
    await at.concierge.following.unfollow(source, target, at.owner);
    return c.json({ ok: true });
  });

  /** Routine `routineId` when the chat's list shows it, else the response that refuses. */
  const routineOf = async (c: Context) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const routineId = c.req.param("routineId") ?? "";
    const { routines } = await at.list.parts(at.chatId, at.owner);
    const row = routines.some((item) => item.id === routineId)
      ? await deps.routinesRepo.findById(routineId)
      : null;
    if (!row) return c.json({ error: "No such routine in this chat" }, 404);
    return row;
  };

  // Pauses or resumes a routine of the chat, as its row's Pause and Resume do.
  for (const [path, enabled] of [
    ["pause", false],
    ["resume", true],
  ] as const) {
    app.post(`/chats/:chatId/tasks/routines/:routineId/${path}`, async (c) => {
      const row = await routineOf(c);
      if (row instanceof Response) return row;
      const routine = toRoutine(row);
      // A one-off whose time passed while paused has nothing left to fire.
      if (
        enabled &&
        routine.trigger.type === "schedule" &&
        datedOneOffState(routine.trigger) !== null
      ) {
        return c.json({ error: "This one-off's time has passed and it can no longer run." }, 400);
      }
      await deps.routinesRepo.update(routine.id, { enabled });
      await deps.routineEngine.deactivate(routine.id);
      if (enabled) await deps.routineEngine.activate({ ...routine, enabled });
      return c.json({ ok: true });
    });
  }

  // Deletes a routine of the chat, as its row's Delete does once confirmed.
  app.delete("/chats/:chatId/tasks/routines/:routineId", async (c) => {
    const row = await routineOf(c);
    if (row instanceof Response) return row;
    // No actor: a routine an app manages is refused, as on the Routines page.
    const result = await deps.routinesRepo.deleteIfNoActiveRuns(row.id);
    switch (result.status) {
      case "not-found":
        return c.json({ error: "No such routine in this chat" }, 404);
      case "managed":
        return c.json({ error: `This routine is managed by the "${result.managedBy}" app.` }, 403);
      case "active-runs":
        return c.json({ error: "This routine is running now; try again when it ends." }, 409);
      case "deleted":
        await deps.routineEngine.deactivate(row.id);
        return c.json({ ok: true });
    }
  });

  return app;
}
