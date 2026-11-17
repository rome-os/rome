import { createServer } from "node:http";
import { once } from "node:events";
import { type AddressInfo, connect } from "node:net";
import { describe, expect, it } from "@rstest/core";
import { attachTerminalServer, TERMINAL_COMMAND_PRESETS } from "./terminal-server.js";
import { createVisitorSession } from "./access/auth.js";
import { DashboardAccessState } from "./access/dashboard-access-state.js";
import { createTestDb } from "./test/db.js";

describe("TERMINAL_COMMAND_PRESETS", () => {
  it("logs in via `claude /login` — the watcher auto-drives the first-run choices", () => {
    expect(TERMINAL_COMMAND_PRESETS["claude-login"]).toEqual({
      cmd: "claude",
      args: ["/login"],
    });
  });

  it("exposes only the login preset — logout (Claude + Codex) is non-PTY", () => {
    // Logout runs via HTTP endpoints (`claude auth logout` / the app-server
    // `account/logout` RPC), and Codex login uses the device-code flow. None of
    // them is a PTY preset.
    expect(Object.keys(TERMINAL_COMMAND_PRESETS)).toEqual(["claude-login"]);
    expect(TERMINAL_COMMAND_PRESETS["claude-logout"]).toBeUndefined();
    expect(TERMINAL_COMMAND_PRESETS["codex-login"]).toBeUndefined();
  });
});

describe("attachTerminalServer", () => {
  it("admits a visitor on the dashboard allow-list and refuses one who is not", async () => {
    const dashboardAccess = new DashboardAccessState();
    dashboardAccess.setCloudEmailAccess(["visitor@example.com"]);
    const testDb = createTestDb();
    const server = createServer();
    const handler = attachTerminalServer(server, testDb.db, dashboardAccess);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const status = async (email: string) => {
      const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
      await once(socket, "connect");
      socket.write(
        "GET /ws/terminal?preset=none HTTP/1.1\r\nHost: rome.local\r\n" +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
          `Cookie: rome_visitor=${createVisitorSession("account-1", email)}\r\n` +
          "Origin: http://rome.local\r\nX-Forwarded-For: 203.0.113.1\r\n\r\n",
      );
      const [reply] = (await once(socket, "data")) as [Buffer];
      socket.destroy();
      return reply.toString().split("\r\n")[0]!;
    };
    try {
      // Past the gate: the unknown preset is what refuses it.
      expect(await status("visitor@example.com")).toMatch(/^HTTP\/1\.1 400/);
      expect(await status("stranger@example.com")).toMatch(/^HTTP\/1\.1 401/);
    } finally {
      handler.close();
      server.close();
      testDb.close();
    }
  });
});
