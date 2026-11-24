// Rubric entry 3, the dashboard's half: the guardian removes a teammate, and
// the teammate's open dashboard stops working. Every WebSocket the dashboard
// opens is held open by the teammate and by the guardian, the guardian saves
// the dashboard list without the teammate, and 25 s pass on a clock the check
// moves. Each socket the guardian still holds must be gone for the teammate,
// and the teammate's next dashboard call must be refused.

import { rs } from "@rstest/core";
import { WebSocket } from "ws";
import { browserHeaders, callHttp, cookieOf, INSTANCE_HOST, type Role } from "./callers.js";
import { createInstance, TEAMMATE } from "./instance.js";
import { httpOperations, upgradeOperations } from "./surface.js";

/** The longest an open socket may outlive the removal, in moved time. */
export const REMOVAL_GRACE_MS = 25_000;

/** "teammate-kept": the guardian saves the list with the teammate still on
 *  it, so the check must fail. Proves it does not pass on sockets that close
 *  for another reason. */
export type Rule3StandIn = "teammate-kept";

export interface SocketResult {
  route: string;
  /** "closed" or "open" after the removal; "unverified" when the socket never
   *  opened for both, or the guardian's closed too, so it shows nothing. */
  verdict: "closed" | "open" | "unverified";
  detail: string;
}

export interface Rule3Result {
  pass: boolean;
  sockets: SocketResult[];
  /** The teammate's `GET /api/settings` after the removal, through the edge
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

/** Waits real time, up to `ms`, for `held` to close. */
async function closesWithin(held: HeldSocket, ms: number): Promise<boolean> {
  if (held.closedWith !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    held.ws.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function runRule3Dashboard(
  options: { standIn?: Rule3StandIn } = {},
): Promise<Rule3Result> {
  const instance = await createInstance({ dashboardEmails: [TEAMMATE.email] });
  const listening = await instance.listen();
  // Only intervals are moved: the sockets' periodic checks run on them, while
  // the network and the waits below keep real time.
  rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const held: { route: string; guardian: HeldSocket | null; teammate: HeldSocket | null }[] = [];
  try {
    for (const op of upgradeOperations()) {
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

    rs.advanceTimersByTime(REMOVAL_GRACE_MS);

    const sockets: SocketResult[] = [];
    for (const [index, h] of held.entries()) {
      const before = closedBefore[index];
      if (!h.guardian || !h.teammate) {
        sockets.push({
          route: h.route,
          verdict: "unverified",
          detail: `the handshake failed for ${h.guardian ? "the teammate" : "the guardian"}`,
        });
        continue;
      }
      if (before.guardian !== null || before.teammate !== null) {
        sockets.push({
          route: h.route,
          verdict: "unverified",
          detail: `closed before the removal (guardian ${before.guardian}, teammate ${before.teammate})`,
        });
        continue;
      }
      const teammateClosed = await closesWithin(h.teammate, 2_000);
      if (h.guardian.closedWith !== null) {
        sockets.push({
          route: h.route,
          verdict: "unverified",
          detail: `the guardian's socket closed too (${h.guardian.closedWith})`,
        });
        continue;
      }
      sockets.push({
        route: h.route,
        verdict: teammateClosed ? "closed" : "open",
        detail: teammateClosed ? `closed with ${h.teammate.closedWith}` : "still open",
      });
    }

    const settingsRead = httpOperations(instance.app, instance.ids).find(
      (op) => op.route === "GET /api/settings",
    );
    if (!settingsRead) throw new Error("the instance serves no GET /api/settings");
    const next = await callHttp(instance.app, settingsRead, "teammate");
    const checked = sockets.filter((s) => s.verdict !== "unverified");
    return {
      pass: checked.length > 0 && checked.every((s) => s.verdict === "closed") && next.refused,
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
