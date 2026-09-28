import { createServer } from "node:http";
import { once } from "node:events";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { attachDesktopProxy, desktopUpstream } from "./desktop-proxy-server.js";
import { createSession } from "./lib/auth.js";
import { createTestDb } from "./test/helpers.js";

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

describe("attachDesktopProxy", () => {
  it("refuses a WeChat websocket while no WeChat display is configured", async () => {
    rs.stubEnv("WECHAT_USER_DISPLAY", "");
    const testDb = createTestDb();
    const server = createServer();
    const proxy = attachDesktopProxy(server, testDb.db);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
      await once(socket, "connect");
      socket.write(
        "GET /desktop-proxy/wechat/websockify HTTP/1.1\r\nHost: rome.local\r\n" +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
          `Cookie: rome_session=${createSession("guardian")}\r\n` +
          "Origin: http://rome.local\r\nX-Forwarded-For: 203.0.113.1\r\n\r\n",
      );
      const [reply] = (await once(socket, "data")) as [Buffer];
      expect(reply.toString()).toMatch(/^HTTP\/1\.1 404/);
      socket.destroy();
    } finally {
      proxy.close();
      server.close();
      testDb.close();
    }
  });
});
