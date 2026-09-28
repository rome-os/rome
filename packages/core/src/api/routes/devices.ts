import { Hono } from "hono";
import { CallerConfigurationError, DaemonVersionError } from "@rome-os/node-core/client";
import type { ApiDeps } from "../deps.js";

export function devicesRoutes(deps: Pick<ApiDeps, "nodeDevices">): Hono {
  const app = new Hono();
  app.get("/devices", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await deps.nodeDevices.getStatus());
  });
  app.post("/devices/start", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      await deps.nodeDevices.start();
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof CallerConfigurationError && error.code === "not_configured") {
        return c.json({ error: "not_configured" }, 409);
      }
      if (error instanceof DaemonVersionError) {
        return c.json({ error: "incompatible" }, 409);
      }
      return c.json({ error: "start_failed" }, 503);
    }
  });
  return app;
}
