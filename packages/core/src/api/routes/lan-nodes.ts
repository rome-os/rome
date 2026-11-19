import { lanNodeNameSchema, lanSwitchAddressSchema } from "@rome/api-types/devices";
import { Hono } from "hono";
import { z } from "zod";
import { lanNodeGuardian } from "../../access/lan-node-guardian.js";
import { LanNodeError } from "../../desktops/lan-nodes.js";
import type { ApiDeps } from "../deps.js";

const nameBody = z.object({ name: lanNodeNameSchema }).strict();
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
  invalid_lan_address: 400,
  lan_busy: 429,
  lan_auth_required: 422,
  lan_unreachable: 502,
} as const satisfies Record<LanNodeError["code"], number>;

export function lanNodesRoutes({
  db,
  lanNodes,
  localLanNodes,
}: Pick<ApiDeps, "db" | "lanNodes" | "localLanNodes">) {
  const app = new Hono<{ Variables: { accountId: string } }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const guardian = await lanNodeGuardian(c, db, Boolean(localLanNodes));
    if (!guardian) return c.json({ error: "sign_in_required" }, 403);
    c.set("accountId", guardian);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof LanNodeError) return c.json({ error: error.code }, errors[error.code]);
    throw error;
  });
  app.get("/", async (c) =>
    c.json({
      ...(await lanNodes.list(c.get("accountId"), c.req.raw.signal)),
      transport: localLanNodes ? "direct" : "cloud",
    }),
  );
  app.post("/", async (c) => {
    const input = nameBody.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_device_name" }, 400);
    return c.json(await lanNodes.pair(c.get("accountId"), input.data, c.req.raw.signal), 201);
  });
  app.post("/:id/pairing", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "node_not_found" }, 404);
    return c.json(await lanNodes.pair(c.get("accountId"), { id: id.data }, c.req.raw.signal), 201);
  });
  app.delete("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "node_not_found" }, 404);
    await lanNodes.removeInstallation(c.get("accountId"), id.data, c.req.raw.signal);
    return c.body(null, 204);
  });
  app.post("/:id/switch-status", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "node_not_found" }, 404);
    const input = lanSwitchAddressSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_lan_address" }, 400);
    return c.json(
      await lanNodes.switchStatus(
        c.get("accountId"),
        id.data,
        input.data.address,
        c.req.raw.signal,
      ),
    );
  });
  return app;
}
