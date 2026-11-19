import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { LAN_NODE_SOCKET_PATH, type LocalLanNodes } from "../../desktops/local-lan-nodes.js";

const redeemBody = z
  .object({
    installation_id: z.uuid(),
    verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export function lanNodeTransportRoutes(local?: LocalLanNodes) {
  const app = new Hono();
  app.get("/v1/gateway/config", (c) => {
    c.header("Cache-Control", "no-store");
    if (!local) return c.json({ error: "not_configured" }, 404);
    if (!local.findByBearer(c.req.header("Authorization")))
      return c.json({ error: "invalid_device_session" }, 401);
    return c.json({ gatewayPath: LAN_NODE_SOCKET_PATH });
  });
  app.post("/api/devices/lan-nodes/redeem", bodyLimit({ maxSize: 1024 }), async (c) => {
    c.header("Cache-Control", "no-store");
    if (!local) return c.json({ error: "not_configured" }, 404);
    const token = /^Bearer (romeinstall_[A-Za-z0-9_-]{43})$/.exec(
      c.req.header("Authorization") ?? "",
    )?.[1];
    if (!token) return c.json({ error: "invalid_grant" }, 401);
    const input = redeemBody.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    const result = local.redeem(input.data.installation_id, token, input.data.verifier);
    switch (result.outcome) {
      case "redeemed":
        return c.json(result.response);
      case "expired":
        return c.json({ error: "expired_token" }, 410);
      case "claimed":
        return c.json({ error: "invalid_grant" }, 409);
      case "invalid":
        return c.json({ error: "invalid_grant" }, 401);
    }
  });
  return app;
}
