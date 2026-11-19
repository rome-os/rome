import { describe, expect, it, rs } from "@rstest/core";
import { Hono, type MiddlewareHandler } from "hono";
import { WechatAppNotInstalled } from "../wechat-app.js";
import { type WechatAppRoutesDeps, wechatAppRoutes } from "./wechat-app.js";

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

function stubApp(): NonNullable<WechatAppRoutesDeps["wechatApp"]> {
  return {
    status: rs.fn(async () => ({ state: "absent" as const })),
    install: rs.fn(async () => ({ state: "installing" as const })),
    start: rs.fn(async () => ({ state: "starting" as const })),
  };
}

const letIn: MiddlewareHandler = (_c, next) => next();

function build(wechatApp: WechatAppRoutesDeps["wechatApp"], guardianOnly = letIn): Hono {
  const app = new Hono();
  app.route("/", wechatAppRoutes({ wechatApp, guardianOnly }));
  return app;
}

describe("WeChat app API", () => {
  it("reports the app's state", async () => {
    const response = await build(stubApp()).request("/wechat/app");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "absent" });
  });

  it("reports unavailable while WeChat is disabled, and refuses to install", async () => {
    const app = build(null);
    expect(await (await app.request("/wechat/app")).json()).toEqual({ state: "unavailable" });
    const install = await app.request("/wechat/app/install", {
      method: "POST",
      headers: SAME_ORIGIN,
    });
    expect(install.status).toBe(404);
  });

  it("installs and starts in the background", async () => {
    const wechat = stubApp();
    const app = build(wechat);

    const install = await app.request("/wechat/app/install", {
      method: "POST",
      headers: SAME_ORIGIN,
    });
    expect(install.status).toBe(202);
    expect(await install.json()).toEqual({ state: "installing" });

    const start = await app.request("/wechat/app/start", { method: "POST", headers: SAME_ORIGIN });
    expect(start.status).toBe(202);
    expect(wechat.start).toHaveBeenCalledTimes(1);
  });

  it("answers 409 to a start before the client is downloaded", async () => {
    const wechat = stubApp();
    wechat.start = rs.fn(async () => {
      throw new WechatAppNotInstalled();
    });
    const response = await build(wechat).request("/wechat/app/start", {
      method: "POST",
      headers: SAME_ORIGIN,
    });
    expect(response.status).toBe(409);
  });

  it("refuses cross-site writes", async () => {
    const wechat = stubApp();
    const app = build(wechat);
    const origins: Record<string, string>[] = [{ "sec-fetch-site": "cross-site" }, {}];
    for (const headers of origins) {
      const response = await app.request("https://rome.example.com/wechat/app/install", {
        method: "POST",
        headers,
      });
      expect(response.status).toBe(403);
    }
    expect(wechat.install).not.toHaveBeenCalled();
  });

  it("asks the guard before every route", async () => {
    const wechat = stubApp();
    const refuse: MiddlewareHandler = (c) => Promise.resolve(c.json({ error: "no" }, 403));
    const app = build(wechat, refuse);
    expect((await app.request("/wechat/app")).status).toBe(403);
    for (const path of ["/wechat/app/install", "/wechat/app/start"]) {
      expect((await app.request(path, { method: "POST", headers: SAME_ORIGIN })).status).toBe(403);
    }
    expect(wechat.status).not.toHaveBeenCalled();
    expect(wechat.install).not.toHaveBeenCalled();
    expect(wechat.start).not.toHaveBeenCalled();
  });
});
