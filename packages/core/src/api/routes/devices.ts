import { Hono } from "hono";
import { CallerConfigurationError, DaemonVersionError } from "@rome-os/node-core/client";
import type { DeviceFilesErrorCode } from "@rome/api-types/devices";
import type { ApiDeps } from "../deps.js";

const filesErrorStatus = {
  offline: 503,
  upgrade_required: 409,
  not_found: 404,
  not_a_directory: 400,
  permission_denied: 403,
  unavailable: 503,
} as const satisfies Record<DeviceFilesErrorCode, number>;

export function devicesRoutes(deps: Pick<ApiDeps, "nodeDevices">): Hono {
  const app = new Hono();
  app.get("/devices", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await deps.nodeDevices.getStatus());
  });
  // Backs the chat folder picker. Each call is one read-only fs.list on the device.
  app.get("/devices/:deviceId/files", async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await deps.nodeDevices.listFiles(
      c.req.param("deviceId"),
      c.req.query("path") || undefined,
    );
    if (!result.ok) return c.json({ error: result.code }, filesErrorStatus[result.code]);
    return c.json(result.folder);
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
