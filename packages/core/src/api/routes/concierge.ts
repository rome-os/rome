import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";

export function conciergeRoutes(deps: Pick<ApiDeps, "concierge">): Hono {
  const app = new Hono();

  // The single Concierge chat, created on first use. 404 while the setting is off.
  app.get("/concierge/session", async (c) => {
    const concierge = deps.concierge;
    if (!concierge || !(await concierge.isEnabled())) {
      return c.json({ error: "Concierge is off" }, 404);
    }
    return c.json({ id: await concierge.ensureChatId() });
  });

  return app;
}
