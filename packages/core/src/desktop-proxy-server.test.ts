import { createServer } from "node:http";
import { once } from "node:events";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { attachDesktopProxy, desktopUpstream } from "./desktop-proxy-server.js";
import type { Desktop } from "./desktops/manager.js";
import { createSession } from "./lib/auth.js";
import { createTestDb } from "./test/helpers.js";

afterEach(() => {
  rs.unstubAllEnvs();
});

const wechat: Desktop = {
  name: "wechat",
  display: ":100",
  vncPort: 5901,
  novncPort: 6081,
  path: "/desktop/wechat",
};

/** A manager that knows only the desktops it is given, and records lookups. */
function desktopsOf(...running: Desktop[]) {
  const asked: string[] = [];
  return {
    asked,
    get: async (name: string) => {
      asked.push(name);
      return running.find((desktop) => desktop.name === name) ?? null;
    },
  };
}

describe("desktopUpstream", () => {
  it("sends a named desktop's path to its websockify and the rest to the shared one", async () => {
    rs.stubEnv("ROME_NOVNC_PORT", "6080");
    const desktops = desktopsOf(wechat);
    expect(await desktopUpstream("/desktop-proxy/websockify", desktops)).toEqual({
      port: 6080,
      path: "/websockify",
    });
    expect(await desktopUpstream("/desktop-proxy", desktops)).toEqual({ port: 6080, path: "/" });
    expect(await desktopUpstream("/desktop-proxy/wechat/websockify", desktops)).toEqual({
      port: 6081,
      path: "/websockify",
    });
    expect(await desktopUpstream("/desktop-proxy/wechat", desktops)).toEqual({
      port: 6081,
      path: "/",
    });
    expect(await desktopUpstream("/desktop-proxy/wechat?token=1", desktops)).toEqual({
      port: 6081,
      path: "/?token=1",
    });
    expect(desktops.asked).not.toContain("websockify");
  });

  it("has no upstream for a named desktop that is not running", async () => {
    const desktops = desktopsOf(wechat);
    expect(await desktopUpstream("/desktop-proxy/notes/websockify", desktops)).toBeNull();
    expect(await desktopUpstream("/desktop-proxy/notes", desktops)).toBeNull();
    expect(desktops.asked).toEqual(["notes", "notes"]);
  });

  it("keeps paths that cannot name a desktop on the shared websockify", async () => {
    rs.stubEnv("ROME_NOVNC_PORT", "6080");
    const desktops = desktopsOf();
    expect(await desktopUpstream("/desktop-proxy/Wechat/websockify", desktops)).toEqual({
      port: 6080,
      path: "/Wechat/websockify",
    });
    expect(await desktopUpstream("/desktop-proxy/websockify?x=1", desktops)).toEqual({
      port: 6080,
      path: "/websockify?x=1",
    });
    expect(desktops.asked).toEqual([]);
  });
});

describe("attachDesktopProxy", () => {
  it("refuses a websocket for a named desktop that is not running", async () => {
    const testDb = createTestDb();
    const server = createServer();
    const proxy = attachDesktopProxy(server, testDb.db, desktopsOf());
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

  it("asks for no desktop before the guardian gate lets the upgrade through", async () => {
    const testDb = createTestDb();
    const server = createServer();
    const desktops = desktopsOf(wechat);
    const proxy = attachDesktopProxy(server, testDb.db, desktops);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
      await once(socket, "connect");
      socket.write(
        "GET /desktop-proxy/wechat/websockify HTTP/1.1\r\nHost: rome.local\r\n" +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Origin: http://rome.local\r\nX-Forwarded-For: 203.0.113.1\r\n\r\n",
      );
      const [reply] = (await once(socket, "data")) as [Buffer];
      expect(reply.toString()).toMatch(/^HTTP\/1\.1 40[13]/);
      expect(desktops.asked).toEqual([]);
      socket.destroy();
    } finally {
      proxy.close();
      server.close();
      testDb.close();
    }
  });
});
