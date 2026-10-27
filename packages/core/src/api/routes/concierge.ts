import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";

/** The most unread messages the Concierge entry counts; the badge reads 99+ at this. */
export const CONCIERGE_UNREAD_CAP = 100;

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

  return app;
}
