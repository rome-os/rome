// Dashboard console of the local rome-node daemon at `/ws/node`. Each socket gets one bridge
// from @rome-os/node-core/client, which forwards the observation methods to the daemon unchanged.
// The team only: a person dropped from the allow-list loses the socket at the next message either
// way, or at the next recheck. Upgrades skip the edge probe like `/ws/terminal`:
// docs/architecture/access-control.md.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  type ConsoleBridge,
  type ConsoleTransport,
  MAX_CONSOLE_MESSAGE_BYTES,
  nodeConfigFromEnvironment,
  openConsoleBridge,
} from "@rome-os/node-core/client";
import { NODE_CONSOLE_PATH } from "@rome/api-types/node-console";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { DrizzleDb } from "../db/index.js";
import { mayEnter, holdEntry } from "../access/entry.js";
import type { DashboardAllowList, TeamActor } from "../access/team.js";
import { actorOfUpgrade, gateUpgrade } from "../access/ws-guardian-gate.js";
import { rejectUpgrade } from "../lib/ws-upgrade.js";
import { createLogger } from "../logger.js";

const log = createLogger("node-console-server");

const PING_INTERVAL_MS = 25_000;
// The daemon caps its own event backlog at 1 MiB, so a tab that falls further behind than this
// has stopped reading. It reconnects and fills the gap with log.query.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_TRY_AGAIN_LATER = 1013;

export function attachNodeConsoleServer(
  httpServer: Server,
  db: DrizzleDb,
  dashboardAccess: DashboardAllowList,
  openBridge: (transport: ConsoleTransport) => ConsoleBridge = (transport) =>
    openConsoleBridge(nodeConfigFromEnvironment(process.env), transport),
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONSOLE_MESSAGE_BYTES });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== NODE_CONSOLE_PATH) return;
    socket.on("error", () => socket.destroy());
    void gateUpgrade(req, socket, db, dashboardAccess)
      .then((caller) => {
        if (!caller || socket.destroyed) return;
        const actor = actorOfUpgrade(caller);
        wss.handleUpgrade(req, socket, head, (ws) => serve(ws, actor));
      })
      .catch((err) => {
        log.error("node console upgrade failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        rejectUpgrade(socket, 500, "Internal Server Error");
      });
  };
  httpServer.on("upgrade", onUpgrade);

  function serve(ws: WebSocket, actor: TeamActor): void {
    let alive = true;
    const entry = holdEntry(
      async () => (await mayEnter(actor, dashboardAccess)) !== null,
      () => ws.close(CLOSE_POLICY_VIOLATION, "Forbidden"),
    );
    const bridge = openBridge({
      send: (text) => {
        entry.admit(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            ws.close(CLOSE_TRY_AGAIN_LATER, "Client is not reading");
            return;
          }
          ws.send(text);
        });
      },
      close: () => {
        if (ws.readyState === WebSocket.OPEN) ws.close(CLOSE_TRY_AGAIN_LATER, "Daemon unavailable");
      },
    });
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_INTERVAL_MS);
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("message", (raw: RawData, isBinary: boolean) => {
      entry.admit(() => {
        if (isBinary) ws.close(1003, "Text messages only");
        else bridge.receive(raw.toString());
      });
    });
    const teardown = () => {
      clearInterval(ping);
      entry.release();
      bridge.close();
    };
    ws.on("close", teardown);
    ws.on("error", teardown);
  }

  return {
    close() {
      httpServer.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
