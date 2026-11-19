import { Hono } from "hono";
import { CONTAINER_NODE_SOCKET_PATH } from "@rome-os/node-core/container-node-address";
import type { LocalContainerNodes } from "../../desktops/local-container-nodes.js";

export function containerNodeTransportRoutes(local: LocalContainerNodes) {
  return new Hono().get("/v1/gateway/config", (c) => {
    c.header("Cache-Control", "no-store");
    if (!local.findByBearer(c.req.header("Authorization")))
      return c.json({ error: "invalid_device_session" }, 401);
    return c.json({ gatewayPath: CONTAINER_NODE_SOCKET_PATH });
  });
}
