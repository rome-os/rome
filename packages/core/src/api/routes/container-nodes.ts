import { containerNodeNameSchema, shellySwitchAddressSchema } from "@rome/api-types/devices";
import { Hono } from "hono";
import { z } from "zod";
import { containerNodeGuardian } from "../../access/container-node-guardian.js";
import { ContainerNodeError } from "../../desktops/container-nodes.js";
import type { ApiDeps } from "../deps.js";

const nameBody = z.object({ name: containerNodeNameSchema }).strict();
const idSchema = z.uuid();

const errors = {
  not_configured: 409,
  sign_in_required: 403,
  cloud_unsupported: 501,
  unavailable: 503,
  node_not_found: 404,
  already_paired: 409,
  offline: 503,
  needs_pairing: 409,
  invalid_switch_address: 400,
  node_busy: 429,
  switch_auth_required: 422,
  switch_unreachable: 502,
} as const satisfies Record<ContainerNodeError["code"], number>;

export function containerNodesRoutes({
  db,
  containerNodes,
  localContainerNodes,
}: Pick<ApiDeps, "db" | "containerNodes" | "localContainerNodes">) {
  const app = new Hono<{ Variables: { accountId: string } }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const guardian = await containerNodeGuardian(c, db, Boolean(localContainerNodes));
    if (!guardian) return c.json({ error: "sign_in_required" }, 403);
    c.set("accountId", guardian);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ContainerNodeError)
      return c.json({ error: error.code }, errors[error.code]);
    throw error;
  });
  app.get("/", async (c) =>
    c.json({
      ...(await containerNodes.list(c.get("accountId"), c.req.raw.signal)),
      transport: localContainerNodes ? "direct" : "cloud",
    }),
  );
  app.post("/", async (c) => {
    const input = nameBody.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_device_name" }, 400);
    return c.json(await containerNodes.pair(c.get("accountId"), input.data, c.req.raw.signal), 201);
  });
  app.post("/:id/pairing", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "node_not_found" }, 404);
    return c.json(
      await containerNodes.pair(c.get("accountId"), { id: id.data }, c.req.raw.signal),
      201,
    );
  });
  app.delete("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "node_not_found" }, 404);
    await containerNodes.removeInstallation(c.get("accountId"), id.data, c.req.raw.signal);
    return c.body(null, 204);
  });
  app.post("/:id/switch-status", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "node_not_found" }, 404);
    const input = shellySwitchAddressSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_switch_address" }, 400);
    return c.json(
      await containerNodes.switchStatus(
        c.get("accountId"),
        id.data,
        input.data.address,
        c.req.raw.signal,
      ),
    );
  });
  return app;
}
