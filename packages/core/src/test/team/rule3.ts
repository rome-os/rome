// Rubric entry 3, the dashboard's half: the guardian removes a member, and
// Rome refuses what the person asks for next. Every WebSocket the dashboard
// opens is held open by the member and by the guardian, and the guardian saves
// the dashboard list without the member. A live connection is asked about
// once, when it opens (docs/architecture/access-control.md), so after the
// removal the person's next request and each new connection they try must be
// refused, while the connections they already hold stay open as moved time
// passes the old 25 s recheck. The guardian's connections must stay open too.

import { rs } from "@rstest/core";
import { WebSocket } from "ws";
import {
  browserHeaders,
  callHttp,
  callUpgrade,
  cookieOf,
  INSTANCE_HOST,
  type Role,
} from "./callers.js";
import { createInstance, TEAMMATE } from "./instance.js";
import { httpOperations, upgradeOperations } from "./surface.js";

/** Moved time per step of the clock: each step fires every ping and alive
 *  interval once, and the old recheck ran on the same 25 s. */
const STEP_MS = 25_000;
/** Steps the clock moves after the removal, so the held connections see
 *  several pings and outlive the old recheck. */
const STEPS = 3;
/** Real time after each step for a ping's pong to come back, and for a close
 *  the step caused to arrive. */
const SETTLE_MS = 500;

/** "teammate-kept": the guardian saves the list with the member still on it,
 *  so the check must fail: the person's next request and new connections are
 *  admitted. */
export type Rule3StandIn = "teammate-kept";

export interface SocketResult {
  route: string;
  /** What the person's connection opened before the removal did: still
   *  "open" after the moved time, or "closed". "unverified" when it never
   *  opened for both, or the guardian's closed too, so it shows nothing. */
  verdict: "closed" | "open" | "unverified";
  detail: string;
  /** A connection the person tries to open after the removal, through the
   *  edge probe as rule 2 opens it. Absent when the route is unverified. */
  newConnection?: { status: number | "timeout"; refused: boolean };
}

export interface Rule3Result {
  pass: boolean;
  sockets: SocketResult[];
  /** The person's `GET /api/settings` after the removal, through the edge
   *  probe as rule 2 calls it. */
  nextCall: { status: number | "timeout"; refused: boolean };
}

interface HeldSocket {
  ws: WebSocket;
  closedWith: number | null;
}

function hold(port: number, path: string, role: Role): Promise<HeldSocket | null> {
  const cookie = cookieOf(role);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { ...browserHeaders(cookie), host: `127.0.0.1:${port}` },
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(null);
    }, 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      const held: HeldSocket = { ws, closedWith: null };
      ws.once("close", (code) => {
        held.closedWith = code;
      });
      resolve(held);
    });
    ws.once("unexpected-response", () => {
      clearTimeout(timer);
      ws.terminate();
      resolve(null);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

export async function runRule3Dashboard(
  options: { standIn?: Rule3StandIn } = {},
): Promise<Rule3Result> {
  const instance = await createInstance({ dashboardEmails: [TEAMMATE.email] });
  const listening = await instance.listen();
  // Only intervals are moved: the connections' pings run on them, while the
  // network and the waits below keep real time.
  rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const operations = upgradeOperations();
  const held: { route: string; guardian: HeldSocket | null; teammate: HeldSocket | null }[] = [];
  try {
    for (const op of operations) {
      held.push({
        route: op.route,
        guardian: await hold(listening.port, op.path, "guardian"),
        teammate: await hold(listening.port, op.path, "teammate"),
      });
    }
    const closedBefore = held.map((h) => ({
      guardian: h.guardian?.closedWith ?? null,
      teammate: h.teammate?.closedWith ?? null,
    }));

    const list = options.standIn === "teammate-kept" ? [TEAMMATE.email] : [];
    const saved = await instance.app.request(`https://${INSTANCE_HOST}/api/dashboard-access`, {
      method: "PUT",
      headers: { ...browserHeaders(cookieOf("guardian")), "content-type": "application/json" },
      body: JSON.stringify({ cloudEmailAccess: list }),
    });
    if (!saved.ok) throw new Error(`the guardian could not save the list: ${saved.status}`);

    for (let step = 0; step < STEPS; step++) {
      rs.advanceTimersByTime(STEP_MS);
      await settle();
    }

    const sockets: SocketResult[] = [];
    for (const [index, h] of held.entries()) {
      const before = closedBefore[index];
      if (!h.guardian || !h.teammate) {
        sockets.push({
          route: h.route,
          verdict: "unverified",
          detail: `the handshake failed for ${h.guardian ? "the member" : "the guardian"}`,
        });
        continue;
      }
      if (before.guardian !== null || before.teammate !== null) {
        sockets.push({
          route: h.route,
          verdict: "unverified",
          detail: `closed before the removal (guardian ${before.guardian}, member ${before.teammate})`,
        });
        continue;
      }
      if (h.guardian.closedWith !== null) {
        sockets.push({
          route: h.route,
          verdict: "unverified",
          detail: `the guardian's connection closed too (${h.guardian.closedWith})`,
        });
        continue;
      }
      const opened = await callUpgrade(instance.app, listening.port, operations[index], "teammate");
      const stillOpen = h.teammate.closedWith === null;
      sockets.push({
        route: h.route,
        verdict: stillOpen ? "open" : "closed",
        detail: stillOpen ? "still open" : `closed with ${h.teammate.closedWith}`,
        newConnection: { status: opened.status, refused: opened.refused },
      });
    }

    const settingsRead = httpOperations(instance.app, instance.ids).find(
      (op) => op.route === "GET /api/settings",
    );
    if (!settingsRead) throw new Error("the instance serves no GET /api/settings");
    const next = await callHttp(instance.app, settingsRead, "teammate");
    const checked = sockets.filter((s) => s.verdict !== "unverified");
    return {
      pass:
        checked.length > 0 &&
        checked.every((s) => s.verdict === "open" && s.newConnection?.refused === true) &&
        next.refused,
      sockets,
      nextCall: { status: next.status, refused: next.refused },
    };
  } finally {
    rs.useRealTimers();
    for (const h of held) {
      h.guardian?.ws.terminate();
      h.teammate?.ws.terminate();
    }
    await listening.close();
    await instance.close();
  }
}
