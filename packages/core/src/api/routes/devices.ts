import { Hono } from "hono";
import { CallerConfigurationError, DaemonVersionError } from "@rome-os/node-core/client";
import { z } from "zod";
import type { DeviceFilesErrorCode, DeviceManageErrorCode } from "@rome/api-types/devices";
import type { ApiDeps } from "../deps.js";

const filesErrorStatus = {
  offline: 503,
  upgrade_required: 409,
  not_found: 404,
  not_a_directory: 400,
  permission_denied: 403,
  unavailable: 503,
} as const satisfies Record<DeviceFilesErrorCode, number>;

const manageErrorStatus = {
  device_not_found: 404,
  invalid_device_name: 400,
  revocation_pending: 409,
  unavailable: 503,
} as const satisfies Record<DeviceManageErrorCode, number>;

const renameSchema = z.object({ name: z.string() });

export function devicesRoutes(deps: Pick<ApiDeps, "nodeDevices">): Hono {
  const app = new Hono();
  app.get("/devices", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await deps.nodeDevices.getStatus());
  });
  // The chat folder picker's device list. Probes nothing: a device is probed
  // only when the guardian opens it.
  app.get("/devices/list", async (c) => {
    c.header("Cache-Control", "no-store");
    const list = await deps.nodeDevices.listDevices();
    return list ? c.json(list) : c.json({ error: "unavailable" }, 503);
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
  // Rename and remove change the account's device list in Rome Cloud. The
  // device itself is not contacted, so it may be offline.
  app.patch("/devices/:deviceId", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = renameSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_device_name" }, 400);
    const result = await deps.nodeDevices.renameDevice(c.req.param("deviceId"), body.data.name);
    if (!result.ok) return c.json({ error: result.code }, manageErrorStatus[result.code]);
    return c.body(null, 204);
  });
  app.delete("/devices/:deviceId", async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await deps.nodeDevices.removeDevice(c.req.param("deviceId"));
    if (!result.ok) return c.json({ error: result.code }, manageErrorStatus[result.code]);
    return c.body(null, 204);
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
