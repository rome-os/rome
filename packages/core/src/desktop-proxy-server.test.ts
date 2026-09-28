import { createServer } from "node:http";
import { once } from "node:events";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { attachDesktopProxy, desktopUpstream, proxyDesktopHttp } from "./desktop-proxy-server.js";

afterEach(() => {
  rs.unstubAllEnvs();
});

describe("desktopUpstream", () => {
  it("sends /desktop-proxy/wechat to WeChat's websockify and the rest to the shared one", () => {
    rs.stubEnv("WECHAT_USER_ENABLED", "true");
    rs.stubEnv("DISPLAY", ":99");
    rs.stubEnv("WECHAT_USER_DISPLAY", ":100");
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

  it("has no WeChat upstream while WeChat is disabled, even with a display set", () => {
    rs.stubEnv("WECHAT_USER_ENABLED", "false");
    rs.stubEnv("DISPLAY", ":99");
    rs.stubEnv("WECHAT_USER_DISPLAY", ":100");
    expect(desktopUpstream("/desktop-proxy/wechat/websockify")).toBeNull();
  });

  it("has no WeChat upstream for a display the shared rule rejects", () => {
    rs.stubEnv("WECHAT_USER_ENABLED", "true");
    rs.stubEnv("DISPLAY", ":99");
    rs.stubEnv("WECHAT_USER_DISPLAY", ":99");
    expect(desktopUpstream("/desktop-proxy/wechat/websockify")).toBeNull();
  });

  it("has no WeChat upstream while no WeChat display is configured", () => {
    rs.stubEnv("WECHAT_USER_DISPLAY", "");
    expect(desktopUpstream("/desktop-proxy/wechat/websockify")).toBeNull();
    expect(desktopUpstream("/desktop-proxy/wechat")).toBeNull();
    expect(desktopUpstream("/desktop-proxy/websockify")).toMatchObject({ path: "/websockify" });
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
      rs.stubEnv("WECHAT_USER_ENABLED", "true");
      rs.stubEnv("DISPLAY", ":99");
      rs.stubEnv("WECHAT_USER_DISPLAY", ":100");
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

  it("answers 404 and reaches nothing while no WeChat display is configured", async () => {
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.end("some other service");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    try {
      rs.stubEnv("WECHAT_USER_DISPLAY", "");
      rs.stubEnv("ROME_WECHAT_NOVNC_PORT", String((upstream.address() as AddressInfo).port));
      const res = await proxyDesktopHttp(
        new Request("http://rome.local/desktop-proxy/wechat/vnc.html"),
      );
      expect(res.status).toBe(404);
      expect(seen).toEqual([]);
    } finally {
      upstream.close();
    }
  });
});

describe("attachDesktopProxy", () => {
  it("refuses a WeChat websocket while no WeChat display is configured", async () => {
    rs.stubEnv("WECHAT_USER_DISPLAY", "");
    const server = createServer();
    const proxy = attachDesktopProxy(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
      await once(socket, "connect");
      socket.write(
        "GET /desktop-proxy/wechat/websockify HTTP/1.1\r\nHost: rome.local\r\n" +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      const [reply] = (await once(socket, "data")) as [Buffer];
      expect(reply.toString()).toMatch(/^HTTP\/1\.1 404/);
      socket.destroy();
    } finally {
      proxy.close();
      server.close();
    }
  });
});
