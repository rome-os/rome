import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConsoleTransport } from "@rome-os/node-core/client";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { WebSocket } from "ws";
import { createVisitorSession } from "../access/auth.js";
import { DashboardAccessState } from "../access/dashboard-access-state.js";
import { ENTRY_RECHECK_MS } from "../access/held-entry.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { attachNodeConsoleServer } from "./node-console-server.js";

const ADMIN = "ada@example.com";

describe("node console socket", () => {
  let testDb: TestDb;
  let server: Server;
  let nodeConsole: { close(): void };
  let dashboardAccess: DashboardAccessState;
  // What the daemon received, and the way back to the dashboard.
  let received: string[];
  let bridgeClosed: boolean;
  let daemon: ConsoleTransport | null;

  beforeEach(async () => {
    rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    testDb = createTestDb();
    dashboardAccess = new DashboardAccessState();
    dashboardAccess.setCloudEmailAccess([ADMIN]);
    received = [];
    bridgeClosed = false;
    daemon = null;
    server = createServer();
    nodeConsole = attachNodeConsoleServer(server, testDb.db, dashboardAccess, (transport) => {
      daemon = transport;
      return { receive: (text) => received.push(text), close: () => (bridgeClosed = true) };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    rs.useRealTimers();
    nodeConsole.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    testDb.close();
  });

  async function openAsAdmin() {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/node`, {
      headers: {
        cookie: `rome_visitor=${createVisitorSession("ada", ADMIN)}`,
        origin: "http://rome.example",
        "x-forwarded-for": "203.0.113.1",
        "x-forwarded-host": "rome.example",
        "x-forwarded-proto": "http",
      },
    });
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await rs.waitFor(() => expect(daemon).not.toBeNull());
    return { ws, closed };
  }

  it("closes a member's console at the recheck once they are removed, and its bridge with it", async () => {
    const { ws, closed } = await openAsAdmin();
    ws.send('{"jsonrpc":"2.0","id":1,"method":"node.status"}');
    await rs.waitFor(() => expect(received).toHaveLength(1));

    dashboardAccess.setCloudEmailAccess([]);
    rs.advanceTimersByTime(ENTRY_RECHECK_MS);

    expect(await closed).toBe(1006);
    await rs.waitFor(() => expect(bridgeClosed).toBe(true));
  });
});
