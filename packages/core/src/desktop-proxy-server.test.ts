import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { desktopUpstream, proxyDesktopHttp } from "./desktop-proxy-server.js";

afterEach(() => {
  rs.unstubAllEnvs();
});

describe("desktopUpstream", () => {
  it("sends /desktop-proxy/wechat to WeChat's websockify and the rest to the shared one", () => {
    rs.stubEnv("ROME_NOVNC_PORT", "6080");
    rs.stubEnv("ROME_WECHAT_NOVNC_PORT", "6081");
    expect(desktopUpstream("/desktop-proxy/websockify")).toEqual({
      port: 6080,
      path: "/websockify",
    });
    expect(desktopUpstream("/desktop-proxy")).toEqual({ port: 6080, path: "/" });
    expect(desktopUpstream("/desktop-proxy/wechat/websockify")).toEqual({
      port: 6081,
      path: "/websockify",
    });
    expect(desktopUpstream("/desktop-proxy/wechat")).toEqual({ port: 6081, path: "/" });
    expect(desktopUpstream("/desktop-proxy/wechatty")).toEqual({ port: 6080, path: "/wechatty" });
  });
});

describe("proxyDesktopHttp", () => {
  it("forwards a WeChat desktop request to WeChat's websockify", async () => {
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.end("wechat display");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    try {
      rs.stubEnv("ROME_WECHAT_NOVNC_PORT", String((upstream.address() as AddressInfo).port));
      const res = await proxyDesktopHttp(
        new Request("http://rome.local/desktop-proxy/wechat/vnc.html?x=1"),
      );
      expect(await res.text()).toBe("wechat display");
      expect(seen).toEqual(["/vnc.html?x=1"]);
    } finally {
      upstream.close();
    }
  });
});
