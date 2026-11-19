import { Hono } from "hono";
import { CallerConfigurationError, DaemonVersionError } from "@rome-os/node-core/client";
import { z } from "zod";
import {
  containerNodeNameSchema,
  type DeviceFilesErrorCode,
  type DeviceManageErrorCode,
} from "@rome/api-types/devices";
import { containerNodeGuardian } from "../../access/container-node-guardian.js";
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

export function devicesRoutes({
  db,
  nodeDevices,
  localContainerNodes,
  containerNodes,
}: Pick<ApiDeps, "localContainerNodes"> &
  Partial<Pick<ApiDeps, "db" | "containerNodes">> & {
    nodeDevices: Omit<ApiDeps["nodeDevices"], "runAction">;
  }): Hono {
  const app = new Hono();
  app.get("/devices", async (c) => {
    c.header("Cache-Control", "no-store");
    const status = await nodeDevices.getStatus();
    const owner = localContainerNodes && db ? await containerNodeGuardian(c, db, true) : null;
    const localDevices = owner ? (localContainerNodes?.list(owner) ?? []) : [];
    return c.json({
      ...status,
      containerNodeTransport: localContainerNodes ? "direct" : "cloud",
      devices: [...status.devices, ...localDevices],
    });
  });
  // The chat folder picker's device list. Probes nothing: a device is probed
  // only when the guardian opens it.
  app.get("/devices/list", async (c) => {
    c.header("Cache-Control", "no-store");
    const list = await nodeDevices.listDevices();
    return list ? c.json(list) : c.json({ error: "unavailable" }, 503);
  });
  // Backs the chat folder picker. Each call is one read-only fs.list on the device.
  app.get("/devices/:deviceId/files", async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await nodeDevices.listFiles(
      c.req.param("deviceId"),
      c.req.query("path") || undefined,
    );
    if (!result.ok) return c.json({ error: result.code }, filesErrorStatus[result.code]);
    return c.json(result.folder);
  });
  app.patch("/devices/:deviceId", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.param("deviceId");
    const body = renameSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_device_name" }, 400);
    const owner = localContainerNodes?.deviceOwner(id);
    if (owner && localContainerNodes) {
      if (!db || owner !== (await containerNodeGuardian(c, db, true)))
        return c.json({ error: "sign_in_required" }, 403);
      const name = containerNodeNameSchema.safeParse(body.data.name);
      if (!name.success) return c.json({ error: "invalid_device_name" }, 400);
      return localContainerNodes.rename(owner, id, name.data)
        ? c.body(null, 204)
        : c.json({ error: "device_not_found" }, 404);
    }
    const result = await nodeDevices.renameDevice(id, body.data.name);
    if (!result.ok) return c.json({ error: result.code }, manageErrorStatus[result.code]);
    return c.body(null, 204);
  });
  app.delete("/devices/:deviceId", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.param("deviceId");
    const owner = localContainerNodes?.deviceOwner(id);
    if (owner && localContainerNodes) {
      if (!db || owner !== (await containerNodeGuardian(c, db, true)))
        return c.json({ error: "sign_in_required" }, 403);
      return localContainerNodes.remove(owner, id)
        ? c.body(null, 204)
        : c.json({ error: "device_not_found" }, 404);
    }
    const result = await nodeDevices.removeDevice(id);
    if (!result.ok) return c.json({ error: result.code }, manageErrorStatus[result.code]);
    containerNodes?.forgetCloudDevice(id.toLowerCase());
    return c.body(null, 204);
  });
  app.post("/devices/start", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      await nodeDevices.start();
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
