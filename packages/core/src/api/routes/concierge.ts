import {
  type ConciergeChatsResponse,
  type ConciergeChatStartRequest,
  CONCIERGE_DONE_DAYS,
  type ConciergeConnectorsResponse,
  type ConciergeTasksResponse,
} from "@rome/api-types/concierge";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { currentSessionActor, sessionOwnerKey } from "../../lib/session-actor.js";
import type { ApiDeps } from "../deps.js";

/** The most unread messages the Concierge entry counts; the badge reads 99+ at this. */
export const CONCIERGE_UNREAD_CAP = 100;

/** The most days of finished rows a caller can ask the task list for. */
const MAX_DONE_DAYS = 3650;

export function conciergeRoutes(
  deps: Pick<ApiDeps, "concierge" | "dashboardAccessState" | "webchatRepo">,
): Hono {
  const app = new Hono();

  /**
   * Whose Concierge the caller reaches: the guardian's, or a dashboard
   * visitor's own. Null for anyone else, app users included.
   */
  const callerOwner = async (): Promise<string | null> => {
    const actor = await currentSessionActor();
    if (actor?.kind === "guardian") return sessionOwnerKey(actor);
    if (actor?.kind === "visitor" && deps.dashboardAccessState.isCloudEmailAllowed(actor.email)) {
      return sessionOwnerKey(actor);
    }
    return null;
  };

  // The caller's main Concierge chat, created on first use, and how many
  // agent messages it got since it was last read. 404 while the setting is off.
  app.get("/concierge/session", async (c) => {
    const owner = await callerOwner();
    if (!owner) return c.json({ error: "Not authenticated" }, 401);
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return c.json({ error: "Concierge is off" }, 404);
    }
    const id = await concierge.ensureChatId(owner);
    const unread = await deps.webchatRepo.countUnreadAgentMessages(id, CONCIERGE_UNREAD_CAP);
    return c.json({ id, unread });
  });

  // The caller's Concierge chats: the main chat, created on first use, then
  // the topic chats, each with its unread count. 404 while the setting is off.
  app.get("/concierge/chats", async (c) => {
    const owner = await callerOwner();
    if (!owner) return c.json({ error: "Not authenticated" }, 401);
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return c.json({ error: "Concierge is off" }, 404);
    }
    const chats = await Promise.all(
      (await concierge.listChats(owner)).map(async (chat) => ({
        ...chat,
        unread: await deps.webchatRepo.countUnreadAgentMessages(chat.id, CONCIERGE_UNREAD_CAP),
      })),
    );
    return c.json({ chats } satisfies ConciergeChatsResponse);
  });

  // Starts a topic chat for the caller on their main chat's model. 404 while off.
  app.post("/concierge/chats", async (c) => {
    const owner = await callerOwner();
    if (!owner) return c.json({ error: "Not authenticated" }, 401);
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return c.json({ error: "Concierge is off" }, 404);
    }
    const body = await c.req
      .json<Partial<ConciergeChatStartRequest>>()
      .catch(() => ({}) as Partial<ConciergeChatStartRequest>);
    // No name starts an untitled chat, which its first message names.
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
      return c.json({ error: "name must not be empty" }, 400);
    }
    const chat = await concierge.startTopicChat(owner, body.name);
    return c.json({ ...chat, unread: 0 }, 201);
  });

  // The caller's Concierge todo list: every open row whatever its age, and
  // the finished ones of the last `doneDays` days. 404 while the setting is off.
  app.get("/concierge/tasks", async (c) => {
    const owner = await callerOwner();
    if (!owner) return c.json({ error: "Not authenticated" }, 401);
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return c.json({ error: "Concierge is off" }, 404);
    }
    const asked = Number(c.req.query("doneDays") ?? CONCIERGE_DONE_DAYS);
    const doneDays =
      Number.isFinite(asked) && asked >= 0 ? Math.min(asked, MAX_DONE_DAYS) : CONCIERGE_DONE_DAYS;
    const tasks = await concierge.deps.tasks.listForPanel(owner, doneDays);
    return c.json({ tasks } satisfies ConciergeTasksResponse);
  });

  // The same `task_upsert` events as the `concierge.tasks` topic of the live
  // events socket, for a tab that cannot open the socket: the caller's rows
  // only, and the gate runs before the stream opens.
  app.get("/concierge/tasks/events", async (c) => {
    const owner = await callerOwner();
    if (!owner) return c.json({ error: "Not authenticated" }, 401);
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return c.json({ error: "Concierge is off" }, 404);
    }
    return streamSSE(c, async (sse) => {
      let close!: () => void;
      let finished = false;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      let unsubscribe = () => {};
      const heartbeat = setInterval(() => {
        sse.writeSSE({ event: "keepalive", data: "" }).catch(finish);
      }, 20_000);
      function finish() {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        unsubscribe();
        close();
      }
      unsubscribe = concierge.deps.tasks.subscribe((event, data) => {
        sse.writeSSE({ event, data: JSON.stringify(data) }).catch(finish);
      }, owner);
      sse.onAbort(finish);
      await closed;
    });
  });

  // The Concierge's connectors: every tool it can act through or watch, with
  // what it follows there, and the rules. The same structure its following
  // list returns, read by native clients. The caller's follows and rules;
  // 404 while off.
  const followingOf = async (c: Context) => {
    const owner = await callerOwner();
    if (!owner) return { error: c.json({ error: "Not authenticated" }, 401) };
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return { error: c.json({ error: "Concierge is off" }, 404) };
    }
    return { following: concierge.following, owner };
  };
  const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

  app.get("/concierge/connectors", async (c) => {
    const { following, owner, error } = await followingOf(c);
    if (error) return error;
    try {
      return c.json((await following.list(owner)) satisfies ConciergeConnectorsResponse);
    } catch (err) {
      return c.json({ error: messageOf(err) }, 502);
    }
  });

  // The caller's browser time zone, which a visitor's digest times and quiet
  // hours are read in. The guardian's comes from their own setting, so theirs
  // changes nothing here.
  app.put("/concierge/timezone", async (c) => {
    const { following, owner, error } = await followingOf(c);
    if (error) return error;
    const body = await c.req
      .json<{ timeZone?: unknown }>()
      .catch(() => ({}) as { timeZone?: unknown });
    const timeZone = typeof body.timeZone === "string" ? body.timeZone.trim() : "";
    if (!isTimeZone(timeZone)) return c.json({ error: "timeZone must be an IANA time zone" }, 400);
    await following.setTimezone(owner, timeZone);
    return c.body(null, 204);
  });

  return app;
}

function isTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
