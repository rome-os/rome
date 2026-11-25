// A member removed while a connection of theirs is open. The
// sockets with a test file of their own (/ws/events, /ws/node and
// /ws/voice-conversation) are covered there.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { WebSocket, WebSocketServer } from "ws";
import { createVisitorSession } from "./access/auth.js";
import { DashboardAccessState } from "./access/dashboard-access-state.js";
import { ENTRY_RECHECK_MS } from "./access/entry.js";
import { attachDesktopProxy } from "./desktops/desktop-proxy-server.js";
import { attachTerminalServer, TERMINAL_COMMAND_PRESETS } from "./terminal-server.js";
import { createTestDb, type TestDb } from "./test/db.js";
import { attachVoiceInputServer, type VoiceInputSource } from "./voice-input/index.js";

const PRESET = "test-echo";

let testDb: TestDb;
let server: Server;
let port: number;
let dashboardAccess: DashboardAccessState;
let cleanups: (() => void)[];

const listen = (s: Server) =>
  new Promise<number>((resolve) => {
    s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port));
  });

beforeEach(async () => {
  testDb = createTestDb();
  dashboardAccess = new DashboardAccessState();
  dashboardAccess.setCloudEmailAccess(["ada@example.com"]);
  server = createServer();
  port = await listen(server);
  cleanups = [];
});

afterEach(() => {
  rs.useRealTimers();
  for (const cleanup of cleanups.reverse()) cleanup();
  server.closeAllConnections();
  server.close();
  testDb.close();
});

async function connect(path: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: {
      "x-forwarded-for": "203.0.113.1",
      "x-forwarded-host": "rome.example",
      "x-forwarded-proto": "http",
      cookie: `rome_visitor=${createVisitorSession("ada", "ada@example.com")}`,
      origin: "http://rome.example",
    },
  });
  cleanups.push(() => ws.terminate());
  const messages: string[] = [];
  ws.on("message", (data) => messages.push(data.toString()));
  const closed = new Promise<number>((resolve) => ws.once("close", resolve));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, messages, closed, said: () => messages.join("") };
}

const removeMember = () => dashboardAccess.setCloudEmailAccess([]);
const fakeIntervals = () => rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

describe("the terminal", () => {
  beforeEach(() => {
    TERMINAL_COMMAND_PRESETS[PRESET] = { cmd: "sh", args: ["-c", "cat"] };
    const handler = attachTerminalServer(server, testDb.db, dashboardAccess);
    cleanups.push(
      () => handler.close(),
      () => delete TERMINAL_COMMAND_PRESETS[PRESET],
    );
  });

  it("closes at the recheck", async () => {
    fakeIntervals();
    const { closed } = await connect(`/ws/terminal?preset=${PRESET}`);
    removeMember();
    rs.advanceTimersByTime(ENTRY_RECHECK_MS);
    expect(await closed).toBe(1008);
  });

  it("takes no input", async () => {
    const { ws, closed, said } = await connect(`/ws/terminal?preset=${PRESET}`);
    const type = (data: string) => ws.send(JSON.stringify({ type: "input", data }));
    type("as a member\r");
    await rs.waitFor(() => expect(said()).toContain("as a member"), { timeout: 5_000 });
    removeMember();
    type("after removal\r");
    expect(await closed).toBe(1008);
    expect(said()).not.toContain("after removal");
  });
});

describe("the desktop proxy", () => {
  let received: string[];

  beforeEach(async () => {
    received = [];
    const upstream = createServer();
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
        ws.send(`echo ${data}`);
      });
    });
    const before = process.env.ROME_NOVNC_PORT;
    process.env.ROME_NOVNC_PORT = String(await listen(upstream));
    const handler = attachDesktopProxy(server, testDb.db, dashboardAccess);
    cleanups.push(() => {
      handler.close();
      for (const client of wss.clients) client.terminate();
      upstream.close();
      if (before === undefined) delete process.env.ROME_NOVNC_PORT;
      else process.env.ROME_NOVNC_PORT = before;
    });
  });

  it("closes at the recheck", async () => {
    fakeIntervals();
    const { closed } = await connect("/desktop-proxy/websockify");
    removeMember();
    rs.advanceTimersByTime(ENTRY_RECHECK_MS);
    expect(await closed).toBe(1006);
  });

  it("takes no input", async () => {
    const { ws, closed, said } = await connect("/desktop-proxy/websockify");
    ws.send("as a member");
    await rs.waitFor(() => expect(said()).toContain("echo as a member"));
    removeMember();
    ws.send("after removal");
    await closed;
    expect(received).toEqual(["as a member"]);
  });
});

describe("voice input", () => {
  let audio: number;
  let aborted: boolean;

  beforeEach(() => {
    audio = 0;
    aborted = false;
    const source: VoiceInputSource = {
      available: () => true,
      info: async () => ({ available: true, place: null }),
      open: async () => ({
        ok: true,
        source: {
          romeCloudSessionId: "session-1",
          transcriber: {
            providerId: "test",
            model: "test",
            place: { provider: "test", region: "test" },
            open: () => ({
              sentBytes: 0,
              sendAudio: () => {
                audio += 1;
              },
              finish: () => {},
              abort: () => {
                aborted = true;
              },
            }),
          },
        },
      }),
    } as unknown as VoiceInputSource;
    const handler = attachVoiceInputServer(
      server,
      testDb.db,
      source,
      null,
      dashboardAccess,
      async () => [],
    );
    cleanups.push(() => handler.close());
  });

  const dictate = async () => {
    const connection = await connect("/ws/voice-input");
    connection.ws.send(JSON.stringify({ type: "start", sampleRate: 16_000 }));
    connection.ws.send(Buffer.alloc(320));
    await rs.waitFor(() => expect(audio).toBe(1));
    return connection;
  };

  it("closes at the recheck, and stops listening", async () => {
    fakeIntervals();
    const { closed } = await dictate();
    removeMember();
    rs.advanceTimersByTime(ENTRY_RECHECK_MS);
    expect(await closed).toBe(1008);
    expect(aborted).toBe(true);
  });

  it("takes no audio", async () => {
    const { ws, closed } = await dictate();
    removeMember();
    ws.send(Buffer.alloc(320));
    expect(await closed).toBe(1008);
    expect([audio, aborted]).toEqual([1, true]);
  });
});
