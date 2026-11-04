import {
  CONCIERGE_DONE_DAYS,
  type ConciergeFollowingResponse,
  type ConciergeTasksResponse,
} from "@rome/api-types/concierge";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolveGuardianSession } from "../../lib/guardian-session.js";
import { changeOf, validateRulesChange } from "../../concierge/following.js";
import type { ApiDeps } from "../deps.js";

/** The most unread messages the Concierge entry counts; the badge reads 99+ at this. */
export const CONCIERGE_UNREAD_CAP = 100;

/** The most days of finished rows a caller can ask the task list for. */
const MAX_DONE_DAYS = 3650;

export function conciergeRoutes(deps: Pick<ApiDeps, "concierge" | "db" | "webchatRepo">): Hono {
  const app = new Hono();

  // The single Concierge chat, created on first use, and how many agent
  // messages it got since the guardian last read it. 404 while the setting is off.
  app.get("/concierge/session", async (c) => {
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return c.json({ error: "Concierge is off" }, 404);
    }
    const id = await concierge.ensureChatId();
    const unread = await deps.webchatRepo.countUnreadAgentMessages(id, CONCIERGE_UNREAD_CAP);
    return c.json({ id, unread });
  });

  // The Concierge's todo list: every open row whatever its age, and the
  // finished ones of the last `doneDays` days. Guardian-only, like the
  // `concierge.tasks` socket topic; 404 while the setting is off.
  app.get("/concierge/tasks", async (c) => {
    if (!(await resolveGuardianSession(c, deps.db))) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return c.json({ error: "Concierge is off" }, 404);
    }
    const asked = Number(c.req.query("doneDays") ?? CONCIERGE_DONE_DAYS);
    const doneDays =
      Number.isFinite(asked) && asked >= 0 ? Math.min(asked, MAX_DONE_DAYS) : CONCIERGE_DONE_DAYS;
    const tasks = await concierge.deps.tasks.listForPanel(doneDays);
    return c.json({ tasks } satisfies ConciergeTasksResponse);
  });

  // The same `task_upsert` events as the `concierge.tasks` topic of the live
  // events socket, for a tab that cannot open the socket. Guardian-only, and
  // the gate runs before the stream opens.
  app.get("/concierge/tasks/events", async (c) => {
    if (!(await resolveGuardianSession(c, deps.db))) {
      return c.json({ error: "Not authenticated" }, 401);
    }
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
      });
      sse.onAbort(finish);
      await closed;
    });
  });

  // The Following panel: every source the guardian's connections offer, what
  // the Concierge follows there, and the rules. The same structure the
  // Concierge's following list returns. Guardian-only; 404 while off.
  const followingOf = async (c: Context) => {
    if (!(await resolveGuardianSession(c, deps.db))) {
      return { error: c.json({ error: "Not authenticated" }, 401) };
    }
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return { error: c.json({ error: "Concierge is off" }, 404) };
    }
    return { following: concierge.following };
  };
  const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

  app.get("/concierge/following", async (c) => {
    const { following, error } = await followingOf(c);
    if (error) return error;
    try {
      return c.json((await following.list()) satisfies ConciergeFollowingResponse);
    } catch (err) {
      return c.json({ error: messageOf(err) }, 502);
    }
  });

  // Changes one follow: kinds on or off, options, the preference.
  app.put("/concierge/following/item", async (c) => {
    const { following, error } = await followingOf(c);
    if (error) return error;
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid request body" }, 400);
    const change = changeOf(body);
    if (!change.source) return c.json({ error: "source is required" }, 400);
    try {
      const follow = await following.configure(change);
      if (!follow) return c.json({ error: "Not followed" }, 404);
      return c.json({ follow });
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }
  });

  app.delete("/concierge/following/item", async (c) => {
    const { following, error } = await followingOf(c);
    if (error) return error;
    const source = c.req.query("source")?.trim();
    const target = c.req.query("target")?.trim() ?? "";
    if (!source) return c.json({ error: "source is required" }, 400);
    const result = await following.unfollow(source, target);
    if (!result.removed) return c.json({ error: "Not followed" }, 404);
    return c.json(result);
  });

  app.put("/concierge/following/rules", async (c) => {
    const { following, error } = await followingOf(c);
    if (error) return error;
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid request body" }, 400);
    try {
      return c.json({ rules: await following.setRules(validateRulesChange(body)) });
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }
  });

  return app;
}
