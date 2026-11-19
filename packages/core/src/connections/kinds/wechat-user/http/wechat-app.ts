// The WeChat app on WeChat's own desktop (connections/kinds/wechat-user/wechat-app.ts). The
// /desktop/wechat page reads its state and asks for the client to be installed
// or started. No WeChat connection is involved.
//   GET  /api/wechat/app          — state
//   POST /api/wechat/app/install  — download the client, then open it
//   POST /api/wechat/app/start    — open the downloaded client

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { type WechatApp, WechatAppNotInstalled } from "../wechat-app.js";
import { isSameOriginMutationRequest } from "../../../../lib/mutation-origin.js";

export interface WechatAppRoutesDeps {
  /** The WeChat app the routes drive, or null when personal WeChat is off. */
  wechatApp: Pick<WechatApp, "status" | "install" | "start"> | null;
  /** Runs before every route, and lets only the guardian through. */
  guardianOnly: MiddlewareHandler;
}

export function wechatAppRoutes(deps: WechatAppRoutesDeps): Hono {
  const app = new Hono();

  app.use("/wechat/app/*", deps.guardianOnly, async (c, next) => {
    if (c.req.method !== "GET" && !isSameOriginMutationRequest(c.req.raw))
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    await next();
  });

  const disabled = (c: Context) =>
    c.json({ error: "WeChat is not enabled on this instance." }, 404);

  app.get("/wechat/app", async (c) => {
    if (!deps.wechatApp) return c.json({ state: "unavailable" });
    return c.json(await deps.wechatApp.status());
  });

  app.post("/wechat/app/install", async (c) => {
    if (!deps.wechatApp) return disabled(c);
    return c.json(await deps.wechatApp.install(), 202);
  });

  app.post("/wechat/app/start", async (c) => {
    if (!deps.wechatApp) return disabled(c);
    try {
      return c.json(await deps.wechatApp.start(), 202);
    } catch (error) {
      if (error instanceof WechatAppNotInstalled) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  return app;
}
