import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";

export function devicesRoutes(deps: Pick<ApiDeps, "nodeDevices">): Hono {
  const app = new Hono();
  app.get("/devices", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await deps.nodeDevices.getStatus());
  });
  return app;
}
