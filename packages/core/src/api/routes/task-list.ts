import {
  TASK_LIST_CHANGED_EVENT,
  type TaskListChangedEvent,
  type TaskListResponse,
} from "@rome/api-types/task-list";
import type { Context } from "hono";
import { Hono } from "hono";
import { ChatTaskList } from "../../concierge/task-list.js";
import type { ConciergeService } from "../../concierge/service.js";
import type { LiveEventEmit } from "../../lib/live-event.js";
import type { ApiDeps } from "../deps.js";
import { conciergeCallerOwner, streamEvents } from "./concierge.js";

type TaskListApiDeps = Pick<
  ApiDeps,
  | "concierge"
  | "dashboardAccessState"
  | "routinesRepo"
  | "routineRunsRepo"
  | "routineEngine"
  | "webchatRepo"
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
      taskChatPartMessages: (chatId, since) => deps.webchatRepo.taskChatPartMessages(chatId, since),
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
  return list.watch(chatId, owner, () =>
    emit(TASK_LIST_CHANGED_EVENT, { chatId } satisfies TaskListChangedEvent),
  );
}

/**
 * A Concierge chat's task list, the Tasks panel: everything that runs for the
 * chat, and Stop for a task at work. Every route is its owner's only: another
 * caller's chat, or an archived one, is not found. docs/domains/chats.md#task-list
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
    return c.json(
      (await at.list.read(at.chatId, at.owner, { endedBefore })) satisfies TaskListResponse,
    );
  });

  // The same `tasks_changed` events as the `chat.tasks:<chatId>` topic of the
  // live events socket, for a tab that cannot open the socket.
  app.get("/chats/:chatId/tasks/events", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    return streamEvents(c, (emit) => subscribeChatTasks(deps, at.chatId, at.owner, emit));
  });

  // Stops one of the chat's tasks at once, as its card's Stop does.
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

  return app;
}
