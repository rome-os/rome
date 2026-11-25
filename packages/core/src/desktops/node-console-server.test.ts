import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConsoleTransport } from "@rome-os/node-core/client";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { WebSocket } from "ws";
import { createVisitorSession } from "../access/auth.js";
import { DashboardAccessState } from "../access/dashboard-access-state.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { attachNodeConsoleServer } from "./node-console-server.js";

const MEMBER = "ada@example.com";

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
    testDb = createTestDb();
    dashboardAccess = new DashboardAccessState();
    dashboardAccess.setCloudEmailAccess([MEMBER]);
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
    nodeConsole.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    testDb.close();
  });

  async function openAsMember() {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/node`, {
      headers: {
        cookie: `rome_visitor=${createVisitorSession("ada", MEMBER)}`,
        origin: "http://rome.example",
        "x-forwarded-for": "203.0.113.1",
        "x-forwarded-host": "rome.example",
        "x-forwarded-proto": "http",
      },
    });
    const events: string[] = [];
    ws.on("message", (data) => events.push(data.toString()));
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await rs.waitFor(() => expect(daemon).not.toBeNull());
    return { ws, events, closed };
  }

  it("passes a member's message to the daemon and its answer back, and ends its bridge with it", async () => {
    const { ws, events, closed } = await openAsMember();
    ws.send('{"jsonrpc":"2.0","id":1,"method":"node.status"}');
    await rs.waitFor(() =>
      expect(received).toEqual(['{"jsonrpc":"2.0","id":1,"method":"node.status"}']),
    );
    daemon?.send('{"jsonrpc":"2.0","id":1,"result":{}}');
    await rs.waitFor(() => expect(events).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']));

    ws.close();
    await closed;
    await rs.waitFor(() => expect(bridgeClosed).toBe(true));
  });
});
