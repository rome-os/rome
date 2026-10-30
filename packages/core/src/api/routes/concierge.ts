import { CONCIERGE_DONE_DAYS, type ConciergeTasksResponse } from "@rome/api-types/concierge";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ApiDeps } from "../deps.js";

/** The most unread messages the Concierge entry counts; the badge reads 99+ at this. */
export const CONCIERGE_UNREAD_CAP = 100;

/** The most days of finished rows a caller can ask the task list for. */
const MAX_DONE_DAYS = 3650;

export function conciergeRoutes(deps: Pick<ApiDeps, "concierge" | "webchatRepo">): Hono {
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
  // finished ones of the last `doneDays` days. 404 while the setting is off.
  app.get("/concierge/tasks", async (c) => {
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
  // events socket, for a tab that cannot open the socket.
  app.get("/concierge/tasks/events", async (c) => {
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

  return app;
}
