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

function wechatOwnDisplay() {
  rs.stubEnv("WECHAT_USER_ENABLED", "true");
  rs.stubEnv("DISPLAY", ":99");
  rs.stubEnv("WECHAT_USER_DISPLAY", ":100");
  rs.stubEnv("ROME_NOVNC_PORT", "6080");
  rs.stubEnv("ROME_WECHAT_NOVNC_PORT", "6081");
}

describe("desktopUpstream", () => {
  it("sends a named desktop's paths to its websockify and the shared paths to the shared one", () => {
    wechatOwnDisplay();
    expect(desktopUpstream("/desktop-proxy/websockify")).toEqual({
      port: 6080,
      path: "/websockify",
    });
    expect(desktopUpstream("/desktop-proxy/websockify?x=1")).toEqual({
      port: 6080,
      path: "/websockify?x=1",
    });
    expect(desktopUpstream("/desktop-proxy")).toEqual({ port: 6080, path: "/" });
    expect(desktopUpstream("/desktop-proxy/wechat/websockify")).toEqual({
      port: 6081,
      path: "/websockify",
    });
    expect(desktopUpstream("/desktop-proxy/wechat")).toEqual({ port: 6081, path: "/" });
    expect(desktopUpstream("/desktop-proxy/wechat?token=1")).toEqual({
      port: 6081,
      path: "/?token=1",
    });
  });

  it("has no upstream for a segment that names no desktop", () => {
    wechatOwnDisplay();
    for (const path of [
      "/desktop-proxy/notes/websockify",
      "/desktop-proxy/Wechat/websockify",
      "/desktop-proxy/my_desk",
      "/desktop-proxy/wechatty",
    ]) {
      expect(desktopUpstream(path)).toBeNull();
    }
  });

  it("has no wechat upstream while WeChat has no display of its own", () => {
    rs.stubEnv("WECHAT_USER_ENABLED", "true");
    rs.stubEnv("WECHAT_USER_DISPLAY", "");
    expect(desktopUpstream("/desktop-proxy/wechat/websockify")).toBeNull();
    expect(desktopUpstream("/desktop-proxy/websockify")).toMatchObject({ path: "/websockify" });
  });
});

describe("attachDesktopProxy", () => {
  it("refuses a websocket for a desktop the table does not have", async () => {
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
