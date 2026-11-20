import { createServer } from "node:http";
import { once } from "node:events";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { attachDesktopProxy, desktopUpstream } from "./desktop-proxy-server.js";
import { createSession } from "../access/auth.js";
import { DashboardAccessState } from "../access/dashboard-access-state.js";
import { createTestDb } from "../test/db.js";

afterEach(() => {
  rs.unstubAllEnvs();
});

describe("desktopUpstream", () => {
  it("sends the shared paths to the shared desktop's websockify", () => {
    rs.stubEnv("ROME_NOVNC_PORT", "6080");
    expect(desktopUpstream("/desktop-proxy/websockify")).toEqual({
      port: 6080,
      path: "/websockify",
    });
    expect(desktopUpstream("/desktop-proxy/websockify?x=1")).toEqual({
      port: 6080,
      path: "/websockify?x=1",
    });
    expect(desktopUpstream("/desktop-proxy")).toEqual({ port: 6080, path: "/" });
  });

  it("has no upstream for any other first segment", () => {
    for (const path of [
      "/desktop-proxy/wechat/websockify",
      "/desktop-proxy/notes",
      "/desktop-proxy/my_desk?token=1",
    ]) {
      expect(desktopUpstream(path)).toBeNull();
    }
  });
});

async function upgradeStatus(path: string): Promise<string> {
  const testDb = createTestDb();
  const server = createServer();
  const proxy = attachDesktopProxy(server, testDb.db, new DashboardAccessState());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: rome.local\r\n` +
        "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
        `Cookie: rome_session=${createSession("guardian")}\r\n` +
        "Origin: http://rome.local\r\nX-Forwarded-For: 203.0.113.1\r\n\r\n",
    );
    const [reply] = (await once(socket, "data")) as [Buffer];
    socket.destroy();
    return reply.toString().split("\r\n")[0]!;
  } finally {
    proxy.close();
    server.close();
    testDb.close();
  }
}

describe("attachDesktopProxy", () => {
  it("refuses a websocket for a path that names no desktop", async () => {
    expect(await upgradeStatus("/desktop-proxy/wechat/websockify")).toMatch(/^HTTP\/1\.1 404/);
  });
});
