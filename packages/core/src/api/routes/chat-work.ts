import {
  CHAT_WORK_CHANGED_EVENT,
  type ChatWorkChangedEvent,
  type ChatWorkResponse,
} from "@rome/api-types/chat-work";
import type { Context } from "hono";
import { Hono } from "hono";
import { toRoutine } from "../../db/repositories/routines.js";
import { ChatWork } from "../../concierge/work.js";
import type { ConciergeService } from "../../concierge/service.js";
import type { LiveEventEmit } from "../../lib/live-event.js";
import type { ApiDeps } from "../deps.js";
import { conciergeCallerOwner, streamEvents } from "./concierge.js";
import { datedOneOffState } from "./routines.js";

type ChatWorkApiDeps = Pick<
  ApiDeps,
  "concierge" | "dashboardAccessState" | "routinesRepo" | "routineRunsRepo" | "routineEngine"
>;

const works = new WeakMap<ConciergeService, ChatWork>();

/** The Work tab reader over `deps`, one per Concierge service. Null without the Concierge. */
export function chatWorkOf(deps: ChatWorkApiDeps): ChatWork | null {
  const concierge = deps.concierge;
  if (!concierge) return null;
  let work = works.get(concierge);
  if (!work) {
    work = new ChatWork({
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
    works.set(concierge, work);
  }
  return work;
}

/**
 * Whether Concierge chat `chatId` is `owner`'s and not archived: only its
 * owner reaches its Work tab, and to anyone else it does not exist.
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

/** Emits `work_changed` whenever chat `chatId`'s Work tab may have changed. */
export function subscribeChatWork(
  deps: ChatWorkApiDeps,
  chatId: string,
  owner: string,
  emit: LiveEventEmit,
): () => void {
  const work = chatWorkOf(deps);
  if (!work) return () => {};
  return work.watch(chatId, owner, () =>
    emit(CHAT_WORK_CHANGED_EVENT, { chatId } satisfies ChatWorkChangedEvent),
  );
}

/**
 * A Concierge chat's Work tab: everything that runs for the chat, and what
 * its owner can do to each row. Every route is its owner's only: another
 * caller's chat, or an archived one, is not found. docs/domains/chats.md#work
 */
export function chatWorkRoutes(deps: ChatWorkApiDeps): Hono {
  const app = new Hono();

  /** The chat's owner and the Concierge, or the response that refuses the caller. */
  const gate = async (
    c: Context,
  ): Promise<
    { concierge: ConciergeService; work: ChatWork; chatId: string; owner: string } | Response
  > => {
    const owner = await conciergeCallerOwner(deps.dashboardAccessState);
    if (!owner) return c.json({ error: "Not authenticated" }, 401);
    const concierge = deps.concierge;
    const work = chatWorkOf(deps);
    if (!concierge || !work) return c.json({ error: "Concierge is not available" }, 404);
    const chatId = c.req.param("chatId") ?? "";
    if (!(await ownsConciergeChat(concierge, chatId, owner))) {
      return c.json({ error: "No such Concierge chat" }, 404);
    }
    return { concierge, work, chatId, owner };
  };

  app.get("/chats/:chatId/work", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    return c.json((await at.work.read(at.chatId, at.owner)) satisfies ChatWorkResponse);
  });

  // The same `work_changed` events as the `chat.work:<chatId>` topic of the
  // live events socket, for a tab that cannot open the socket.
  app.get("/chats/:chatId/work/events", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    return streamEvents(c, (emit) => subscribeChatWork(deps, at.chatId, at.owner, emit));
  });

  // Stops one of the chat's tasks at once, as its card's Stop does.
  app.post("/chats/:chatId/work/tasks/:taskId/stop", async (c) => {
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

  // Cancels a check of the chat: a wake-up goes, and a scheduled task's next
  // run is skipped while its schedule stays. One for a task tells the Concierge.
  app.delete("/chats/:chatId/work/checks/:checkId", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const cancelled = await at.concierge.cancelCheckByOwner(at.chatId, c.req.param("checkId"));
    if (!cancelled) return c.json({ error: "No such check in this chat" }, 404);
    return c.json({ ok: true });
  });

  /** A routine that sends into the chat, as stored, or null. */
  const routineOf = async (chatId: string, routineId: string) => {
    const row = await deps.routinesRepo.findById(routineId);
    return row && row.chatId === chatId ? row : null;
  };

  const setEnabled = async (c: Context, enabled: boolean) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const row = await routineOf(at.chatId, c.req.param("routineId") ?? "");
    if (!row) return c.json({ error: "No such routine in this chat" }, 404);
    const routine = toRoutine(row);
    // A one-off whose time passed has nothing left to fire.
    if (
      enabled &&
      routine.trigger.type === "schedule" &&
      datedOneOffState(routine.trigger) !== null
    ) {
      return c.json({ error: "This one-off's time has passed" }, 400);
    }
    await deps.routinesRepo.update(routine.id, { enabled });
    await deps.routineEngine.deactivate(routine.id);
    if (enabled) await deps.routineEngine.activate({ ...routine, enabled: true });
    return c.json({ ok: true });
  };
  app.post("/chats/:chatId/work/routines/:routineId/pause", (c) => setEnabled(c, false));
  app.post("/chats/:chatId/work/routines/:routineId/resume", (c) => setEnabled(c, true));

  // Deletes a routine that sends into the chat. One an app keeps is refused,
  // as on the Routines page, and so is one with a run under way.
  app.delete("/chats/:chatId/work/routines/:routineId", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const row = await routineOf(at.chatId, c.req.param("routineId"));
    if (!row) return c.json({ error: "No such routine in this chat" }, 404);
    const result = await deps.routinesRepo.deleteIfNoActiveRuns(row.id);
    switch (result.status) {
      case "not-found":
        return c.json({ error: "No such routine in this chat" }, 404);
      case "managed":
        return c.json({ error: `The "${result.managedBy}" app keeps this routine` }, 403);
      case "active-runs":
        return c.json({ error: "A run is under way" }, 409);
      case "deleted":
        await deps.routineEngine.deactivate(row.id);
        return c.json({ ok: true });
    }
  });

  // Stops following a target whose alerts come to this chat.
  app.post("/chats/:chatId/work/follows/unfollow", async (c) => {
    const at = await gate(c);
    if (at instanceof Response) return at;
    const body = await c.req
      .json<{ source?: unknown; target?: unknown }>()
      .catch(() => ({}) as { source?: unknown; target?: unknown });
    if (typeof body.source !== "string" || typeof body.target !== "string") {
      return c.json({ error: "source and target are required" }, 400);
    }
    const following = at.concierge.following;
    const here = (await following.followsIn?.(at.chatId, at.owner)) ?? [];
    if (!here.some((item) => item.source === body.source && item.target === body.target)) {
      return c.json({ error: "No such follow in this chat" }, 404);
    }
    await following.unfollow(body.source, body.target, at.owner);
    return c.json({ ok: true });
  });

  return app;
}
