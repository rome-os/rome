import { containerNodeNameSchema, shellySwitchAddressSchema } from "@rome/api-types/devices";
import { containerNodeOrigin } from "@rome-os/node-core/container-node-address";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getGuardianAuthState } from "../../access/guardian-auth-state.js";
import { containerNodeGuardian } from "../../access/container-node-guardian.js";
import {
  ContainerNodeError,
  containerNodeErrors,
  createContainerNodesService,
  shellySwitchStatus,
} from "../../desktops/container-nodes.js";
import type { ApiDeps } from "../deps.js";

const issueBody = z
  .object({ name: containerNodeNameSchema, origin: z.string().max(2048).optional() })
  .strict();

export function containerNodesRoutes(
  {
    db,
    nodeDevices,
    localContainerNodes,
    containerNodes,
  }: Pick<ApiDeps, "db" | "nodeDevices" | "localContainerNodes" | "containerNodes">,
  hosted = createContainerNodesService(),
) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const owner = await containerNodeGuardian(c, db, Boolean(localContainerNodes));
    if (!owner) return c.json({ error: "sign_in_required" }, 403);
    c.set("owner", owner);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ContainerNodeError)
      return c.json({ error: error.code }, containerNodeErrors[error.code]);
    throw error;
  });
  app.post("/", async (c) => {
    const input = issueBody.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_device_name" }, 400);
    const { name, origin } = input.data;
    const owner = c.get("owner");
    if (!localContainerNodes) {
      if (origin !== undefined) return c.json({ error: "invalid_origin" }, 400);
      const cloudOrigin = await hosted.authorize(owner);
      const response = streamSSE(c, async (stream) => {
        const connection = new AbortController();
        stream.onAbort(() => connection.abort());
        const signal = AbortSignal.any([connection.signal, c.req.raw.signal]);
        const send = (event: string, data: unknown) =>
          stream.writeSSE({ event, data: JSON.stringify(data) });
        const keepAlive = setInterval(() => void stream.write(": keepalive\n\n"), 15_000);
        try {
          const credential = await hosted.authorizeDevice(
            cloudOrigin,
            name,
            signal,
            ({ verificationUriComplete, userCode }) => {
              void send("authorization", { verificationUriComplete, userCode });
            },
          );
          signal.throwIfAborted();
          const devices = await nodeDevices.listDevices(true);
          if (!devices) throw new ContainerNodeError("unavailable");
          if (!devices.devices.some(({ id }) => id.toLowerCase() === credential.deviceId))
            throw new ContainerNodeError("approval_account_mismatch");
          const seat = await getGuardianAuthState(db);
          if (!seat.id || seat.accountId !== owner)
            throw new ContainerNodeError("sign_in_required");
          signal.throwIfAborted();
          containerNodes.rememberCloudDevice(seat.id, credential.deviceId, name);
          await send("credential", credential);
        } catch (error) {
          if (!signal.aborted)
            await send("authorization_error", {
              error: error instanceof ContainerNodeError ? error.code : "authorization_failed",
            });
        } finally {
          clearInterval(keepAlive);
        }
      });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    let address: string;
    try {
      address = containerNodeOrigin(origin?.trim() ?? "");
    } catch {
      return c.json({ error: "invalid_origin" }, 400);
    }
    return c.json(localContainerNodes.issue(owner, name, address), 201);
  });
  app.post("/:id/switch-status", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "node_not_found" }, 404);
    const input = shellySwitchAddressSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_switch_address" }, 400);
    const owner = c.get("owner");
    if (localContainerNodes) {
      if (localContainerNodes.deviceOwner(id.data) !== owner)
        return c.json({ error: "node_not_found" }, 404);
      return c.json(
        shellySwitchStatus(
          await localContainerNodes.run(id.data, "shelly.switch.status", input.data),
        ),
      );
    }
    await hosted.authorize(owner);
    return c.json(
      shellySwitchStatus(await nodeDevices.runAction(id.data, "shelly.switch.status", input.data)),
    );
  });
  return app;
}
