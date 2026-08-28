import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  RelayDrainer,
  buildRelayReplayRequest,
  type DrainEvent,
  type RelayDrain,
} from "./drainer.js";
import { RELAY_DRAINED_HEADER } from "./protocol.js";

// A minimal stand-in for the relay's InstanceMailbox DO: on each connection it
// sends `ready` + every un-acked event in seq order, and prunes on `ack`. This
// lets us drive the drainer through real WebSocket frames (black-box) rather
// than poking its internals.
function startFakeRelay(
  events: Array<{ seq: number; body: string; headers?: Record<string, string> }>,
) {
  let ackedUpTo = 0;
  let connections = 0;
  let protocolPings = 0;
  let lastConnectUrl: string | undefined;
  let lastAuthHeader: string | undefined;
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws: ServerSocket, req: IncomingMessage) => {
    connections++;
    lastConnectUrl = req.url;
    lastAuthHeader = req.headers.authorization;
    const pending = events.filter((e) => e.seq > ackedUpTo);
    ws.send(JSON.stringify({ type: "ready", backlog: pending.length }));
    for (const e of pending) {
      ws.send(
        JSON.stringify({
          type: "event",
          seq: e.seq,
          receivedAt: 0,
          method: "POST",
          path: "/h/mailbox",
          headers: {
            "content-type": "application/json",
            "webhook-id": `id-${e.seq}`,
            ...e.headers,
          },
          body: Buffer.from(e.body).toString("base64"),
        }),
      );
    }
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string; seq?: number };
      if (frame.type === "ack" && typeof frame.seq === "number") {
        ackedUpTo = Math.max(ackedUpTo, frame.seq);
      }
    });
    ws.on("ping", () => {
      protocolPings++;
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    wss,
    drain: (): RelayDrain => ({
      connectUrl: `ws://127.0.0.1:${port}/c/mailbox`,
      drainKey: "test-drain-key",
      targetAppId: "connector",
      targetPath: ["webhook"],
    }),
    ackedUpTo: () => ackedUpTo,
    connections: () => connections,
    protocolPings: () => protocolPings,
    lastConnectUrl: () => lastConnectUrl,
    lastAuthHeader: () => lastAuthHeader,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const DEFAULT_TEST_TIMING = {
  initialBackoffMs: 10,
  maxBackoffMs: 100,
  stableResetMs: 60_000,
} as const;

const FIXED_DELIVERY_RETRY_DELAYS_MS = new Set([1_000, 5_000, 30_000]);
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

/** Keep the production retry schedule fixed while making black-box WS tests fast. */
function speedUpDeliveryRetryTimers(): void {
  const realSetTimeout = globalThis.setTimeout;
  rs.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
    realSetTimeout(
      callback,
      FIXED_DELIVERY_RETRY_DELAYS_MS.has(Number(delay)) ? 1 : delay,
      ...args,
    ),
  );
}

describe("RelayDrainer", () => {
  let drainer: RelayDrainer | null = null;
  let relay: ReturnType<typeof startFakeRelay> | null = null;

  afterEach(async () => {
    await drainer?.stop();
    drainer = null;
    relay?.wss.close();
    relay = null;
    rs.restoreAllMocks();
  });

  it("delivers buffered events in seq order with decoded body and acks each", async () => {
    relay = startFakeRelay([
      { seq: 1, body: '{"n":1}' },
      { seq: 2, body: '{"n":2}' },
    ]);
    const delivered: DrainEvent[] = [];
    drainer = new RelayDrainer([relay.drain()], async (_drain, event) => {
      delivered.push(event);
      return { status: 200 };
    });
    drainer.start();

    await waitFor(() => relay!.ackedUpTo() === 2);
    expect(delivered.map((e) => e.seq)).toEqual([1, 2]);
    expect(delivered[0].body && Buffer.from(delivered[0].body).toString("utf8")).toBe('{"n":1}');
    expect(delivered[0].headers["webhook-id"]).toBe("id-1");
  });

  it("delivers a drained event to the configured target app + path", async () => {
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    const seen: Array<{ appId: string; path: string[] }> = [];
    drainer = new RelayDrainer([relay.drain()], async (drain) => {
      seen.push({ appId: drain.targetAppId, path: drain.targetPath });
      return { status: 200 };
    });
    drainer.start();

    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({ appId: "connector", path: ["webhook"] });
  });

  it("acks a permanently-rejected (4xx) event to avoid a poison-redelivery loop", async () => {
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    let calls = 0;
    drainer = new RelayDrainer([relay.drain()], async () => {
      calls++;
      return { status: 401 };
    });
    drainer.start();

    await waitFor(() => relay!.ackedUpTo() === 1);
    // Give any erroneous redelivery a chance to happen, then assert it didn't.
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1);
  });

  it("retries a transient 4xx (429) on the same socket and then acks", async () => {
    speedUpDeliveryRetryTimers();
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    let attempts = 0;
    drainer = new RelayDrainer(
      [relay.drain()],
      async () => {
        attempts++;
        return attempts === 1 ? { status: 429 } : { status: 200 };
      },
      DEFAULT_TEST_TIMING,
    );
    drainer.start();

    await waitFor(() => relay!.ackedUpTo() === 1);
    expect(attempts).toBe(2);
    expect(relay.connections()).toBe(1);
  });

  it("honors a delivery Retry-After without reconnecting the socket", async () => {
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    let attempts = 0;
    drainer = new RelayDrainer(
      [relay.drain()],
      async () => {
        attempts++;
        return { status: 429, retryAfter: "2" };
      },
      DEFAULT_TEST_TIMING,
    );
    drainer.start();

    await waitFor(() => drainer!.getStatus()[0]?.retry?.nextAttemptAt != null);
    const nextAttemptAt = drainer.getStatus()[0]?.retry?.nextAttemptAt!;
    expect(nextAttemptAt - Date.now()).toBeGreaterThanOrEqual(1_800);
    expect(attempts).toBe(1);
    expect(relay.connections()).toBe(1);
  });

  it("preserves a delivery retry budget and deadline across a transport reconnect", async () => {
    speedUpDeliveryRetryTimers();
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    let attempts = 0;
    drainer = new RelayDrainer(
      [relay.drain()],
      async () => {
        attempts++;
        return { status: 503, retryAfter: attempts === 1 ? "2" : null };
      },
      DEFAULT_TEST_TIMING,
    );
    drainer.start();

    await waitFor(() => drainer!.getStatus()[0]?.retry?.seq === 1);
    const firstDeadline = drainer.getStatus()[0]!.retry!.nextAttemptAt;
    for (const socket of relay.wss.clients) socket.close(1001, "transport reset");
    await waitFor(() => relay!.connections() === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(attempts).toBe(1);
    expect(drainer.getStatus()[0]?.retry).toMatchObject({
      seq: 1,
      nextAttemptAt: firstDeadline,
    });

    await waitFor(() => drainer!.getStatus()[0]?.blocked?.seq === 1);
    expect(attempts).toBe(4);
  });

  it("caps a delivery Retry-After at Node's timer maximum", async () => {
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    const realSetTimeout = globalThis.setTimeout;
    const scheduledDelays: number[] = [];
    rs.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      const delayMs = Number(delay);
      scheduledDelays.push(delayMs);
      return realSetTimeout(callback, delayMs > 100_000 ? 60_000 : delay, ...args);
    });
    drainer = new RelayDrainer(
      [relay.drain()],
      async () => ({ status: 429, retryAfter: "2147484" }),
      DEFAULT_TEST_TIMING,
    );
    drainer.start();

    await waitFor(() => drainer!.getStatus()[0]?.retry?.nextAttemptAt != null);
    expect(scheduledDelays).toContain(MAX_NODE_TIMER_DELAY_MS);
    expect(drainer.getStatus()[0]!.retry!.nextAttemptAt - Date.now()).toBeLessThanOrEqual(
      MAX_NODE_TIMER_DELAY_MS,
    );
  });

  it("retries a non-2xx (3xx redirect) on the same socket", async () => {
    speedUpDeliveryRetryTimers();
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    let attempts = 0;
    drainer = new RelayDrainer(
      [relay.drain()],
      async () => {
        attempts++;
        return attempts === 1 ? { status: 302 } : { status: 200 };
      },
      DEFAULT_TEST_TIMING,
    );
    drainer.start();

    await waitFor(() => relay!.ackedUpTo() === 1);
    expect(attempts).toBe(2);
    expect(relay.connections()).toBe(1);
  });

  it("retries a transient 5xx on the same socket", async () => {
    speedUpDeliveryRetryTimers();
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    let attempts = 0;
    drainer = new RelayDrainer(
      [relay.drain()],
      async () => {
        attempts++;
        return attempts === 1 ? { status: 503 } : { status: 200 };
      },
      DEFAULT_TEST_TIMING,
    );
    drainer.start();

    await waitFor(() => relay!.ackedUpTo() === 1);
    expect(attempts).toBe(2);
    expect(relay.connections()).toBe(1);
  });

  it("blocks after the bounded retry budget, preserving the event until a guardian resumes it", async () => {
    speedUpDeliveryRetryTimers();
    relay = startFakeRelay([
      { seq: 1, body: "{}" },
      { seq: 2, body: "{}" },
    ]);
    const delivered: number[] = [];
    let recovered = false;
    drainer = new RelayDrainer(
      [relay.drain()],
      async (_drain, event) => {
        delivered.push(event.seq);
        return event.seq === 1 && !recovered ? { status: 503 } : { status: 200 };
      },
      DEFAULT_TEST_TIMING,
    );
    drainer.start();

    await waitFor(() => drainer!.getStatus()[0]?.blocked?.seq === 1);
    const blocked = drainer.getStatus()[0]!;
    expect(blocked.blocked).toMatchObject({ seq: 1 });
    expect(blocked.lastDeliveryFailure).toMatchObject({ seq: 1, status: 503 });
    expect(relay.ackedUpTo()).toBe(0);
    expect(relay.connections()).toBe(1);
    expect(delivered).toEqual([1, 1, 1, 1]);

    recovered = true;
    expect(drainer.resumeBlocked()).toBe(true);
    await waitFor(() => relay!.ackedUpTo() === 2);
    expect(delivered).toEqual([1, 1, 1, 1, 1, 2]);
    expect(drainer.getStatus()[0]?.blocked).toBeNull();
    expect(drainer.getStatus()[0]?.deliveredCount).toBe(2);
  });

  it("keeps a blocked event blocked across a transport reconnect", async () => {
    speedUpDeliveryRetryTimers();
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    let attempts = 0;
    let recovered = false;
    drainer = new RelayDrainer(
      [relay.drain()],
      async () => {
        attempts++;
        return recovered ? { status: 200 } : { status: 503 };
      },
      DEFAULT_TEST_TIMING,
    );
    drainer.start();

    await waitFor(() => drainer!.getStatus()[0]?.blocked?.seq === 1);
    for (const socket of relay.wss.clients) socket.close(1001, "transport reset");
    await waitFor(() => relay!.connections() === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(attempts).toBe(4);
    expect(drainer.getStatus()[0]?.blocked).toMatchObject({ seq: 1 });

    recovered = true;
    expect(drainer.resumeBlocked()).toBe(true);
    await waitFor(() => relay!.ackedUpTo() === 1);
    expect(attempts).toBe(5);
  });

  it("reports connected status once the socket opens and clears it after stop", async () => {
    relay = startFakeRelay([]);
    drainer = new RelayDrainer([relay.drain()], async () => ({ status: 200 }));
    drainer.start();

    await waitFor(() => drainer!.getStatus()[0]?.connected === true);
    expect(drainer.getStatus()[0]).toMatchObject({ targetAppId: "connector", connected: true });

    await drainer.stop();
    expect(drainer.getStatus()).toEqual([]);
  });

  it("uses WebSocket control frames for periodic heartbeats", async () => {
    rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      relay = startFakeRelay([]);
      drainer = new RelayDrainer([relay.drain()], async () => ({ status: 200 }));
      drainer.start();

      await waitFor(() => drainer!.getStatus()[0]?.connected === true);
      await rs.advanceTimersByTimeAsync(30_000);
      await waitFor(() => relay!.protocolPings() === 1);
    } finally {
      await drainer?.stop();
      drainer = null;
      rs.useRealTimers();
    }
  });

  it("reports connection uptime and delivery counters once events flow", async () => {
    relay = startFakeRelay([
      { seq: 1, body: "{}" },
      { seq: 2, body: "{}" },
    ]);
    drainer = new RelayDrainer([relay.drain()], async () => ({ status: 200 }));
    const before = Date.now();
    drainer.start();

    await waitFor(() => relay!.ackedUpTo() === 2);
    const status = drainer.getStatus()[0];
    expect(status.connected).toBe(true);
    expect(status.connectedSince).toBeGreaterThanOrEqual(before);
    expect(status.backlog).toBe(2);
    expect(status.deliveredCount).toBe(2);
    expect(status.lastEventAt).toBeGreaterThanOrEqual(status.connectedSince!);
  });

  it("does not count a rejected delivery toward the delivered counter", async () => {
    relay = startFakeRelay([{ seq: 1, body: "{}" }]);
    drainer = new RelayDrainer([relay.drain()], async () => ({ status: 401 }));
    drainer.start();

    // Terminal 4xx is acked (poison-drop) but was never processed by an app.
    await waitFor(() => relay!.ackedUpTo() === 1);
    const status = drainer.getStatus()[0];
    expect(status.deliveredCount).toBe(0);
    expect(status.lastEventAt).toBeNull();
  });

  it("presents the drain key as an Authorization bearer header, never on the URL", async () => {
    relay = startFakeRelay([]);
    const base = relay.drain();
    // A pasted connectUrl may carry a query (e.g. a stale `?t=` credential) or
    // `user:pass@` userinfo; the dialed URL must be the bare mailbox path and
    // the handshake must carry only the bearer key (no Basic auth).
    const withSecrets = new URL(`${base.connectUrl}?region=us&t=stale-pasted-key`);
    withSecrets.username = "stale-user";
    withSecrets.password = "stale-pass";
    drainer = new RelayDrainer([{ ...base, connectUrl: withSecrets.toString() }], async () => ({
      status: 200,
    }));
    drainer.start();

    await waitFor(() => drainer!.getStatus()[0]?.connected === true);
    expect(relay.lastAuthHeader()).toBe("Bearer test-drain-key");
    expect(relay.lastConnectUrl()).toBe("/c/mailbox");
  });

  it("ignores a duplicate start() instead of opening a second socket per drain", async () => {
    relay = startFakeRelay([]);
    drainer = new RelayDrainer([relay.drain()], async () => ({ status: 200 }));
    drainer.start();
    await waitFor(() => drainer!.getStatus()[0]?.connected === true);
    drainer.start();

    // Give a stray second connection a chance to land, then assert it didn't.
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.connections()).toBe(1);
    expect(drainer.getStatus()).toHaveLength(1);
  });

  it("awaits the in-flight delivery and acks it before tearing down, dropping the rest of the backlog", async () => {
    relay = startFakeRelay([
      { seq: 1, body: "{}" },
      { seq: 2, body: "{}" },
      { seq: 3, body: "{}" },
    ]);
    let calls = 0;
    let started = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Gate the first delivery so it is provably in flight when we stop().
    drainer = new RelayDrainer([relay.drain()], async () => {
      calls++;
      started = true;
      await gate;
      return { status: 200 };
    });
    drainer.start();

    await waitFor(() => started);
    const stopping = drainer.stop(); // must wait for the in-flight deliver, not race it
    release();
    await stopping;

    // seq 1 was in flight → delivered and acked on the still-open socket (so the
    // relay won't replay it into a new target). seq 2/3 were queued → dropped.
    expect(calls).toBe(1);
    await waitFor(() => relay!.ackedUpTo() === 1);
  });

  it("reload swaps the live connection to a new mailbox and drains it", async () => {
    relay = startFakeRelay([{ seq: 1, body: '{"from":"a"}' }]);
    const second = startFakeRelay([{ seq: 1, body: '{"from":"b"}' }]);
    const delivered: string[] = [];
    drainer = new RelayDrainer([relay.drain()], async (_drain, event) => {
      delivered.push(event.body ? Buffer.from(event.body).toString("utf8") : "");
      return { status: 200 };
    });
    drainer.start();
    await waitFor(() => relay!.ackedUpTo() === 1);

    // Reconfigure (as the settings UI does) to a different mailbox.
    await drainer.reload([second.drain()]);

    try {
      await waitFor(() => second.ackedUpTo() === 1);
      expect(delivered).toEqual(['{"from":"a"}', '{"from":"b"}']);
    } finally {
      second.wss.close();
    }
  });
});

describe("DrainConnection reconnect discipline", () => {
  let drainer: RelayDrainer | null = null;

  afterEach(async () => {
    await drainer?.stop();
    drainer = null;
  });

  // A relay that closes every socket the moment it opens — the shape of the
  // "superseded" duel (two drainers with the same credentials kicking each
  // other) and of a broken proxy. The old reset-backoff-on-open behavior
  // reconnects at the initial delay forever here.
  function startSlammingRelay() {
    let connections = 0;
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws: ServerSocket) => {
      connections++;
      ws.close(1000, "superseded");
    });
    const port = (wss.address() as AddressInfo).port;
    const drain: RelayDrain = {
      connectUrl: `ws://127.0.0.1:${port}/c/mailbox`,
      drainKey: "test-drain-key",
      targetAppId: "connector",
      targetPath: ["webhook"],
    };
    return { wss, drain, connections: () => connections };
  }

  it("keeps escalating backoff when sockets open but die immediately", async () => {
    const relay = startSlammingRelay();
    try {
      drainer = new RelayDrainer([relay.drain], async () => ({ status: 200 }), {
        initialBackoffMs: 100,
        maxBackoffMs: 1_600,
        stableResetMs: 60_000,
      });
      drainer.start();

      await new Promise((r) => setTimeout(r, 1_200));
      // Equal jitter keeps each delay >= base/2, and bases double per attempt
      // (100, 200, 400, 800, ...), so 1.2s admits at most ~6 connections. The
      // old reset-on-open behavior would produce ~20.
      expect(relay.connections()).toBeGreaterThanOrEqual(2);
      expect(relay.connections()).toBeLessThanOrEqual(6);
    } finally {
      await drainer?.stop();
      drainer = null;
      relay.wss.close();
    }
  });

  it("resets backoff only after a connection stays open for stableResetMs", async () => {
    let connections = 0;
    let stableClosedAt = 0;
    let reconnectAfterStableAt = 0;
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws: ServerSocket) => {
      connections++;
      if (connections <= 4) {
        ws.close(1000, "flaky");
        return;
      }
      if (connections === 5) {
        // Outlives stableResetMs (150ms), earning a backoff reset, then drops.
        setTimeout(() => {
          stableClosedAt = Date.now();
          ws.close(1000, "server restart");
        }, 400);
        return;
      }
      reconnectAfterStableAt = Date.now();
    });
    const port = (wss.address() as AddressInfo).port;
    const drain: RelayDrain = {
      connectUrl: `ws://127.0.0.1:${port}/c/mailbox`,
      drainKey: "test-drain-key",
      targetAppId: "connector",
      targetPath: ["webhook"],
    };
    try {
      drainer = new RelayDrainer([drain], async () => ({ status: 200 }), {
        initialBackoffMs: 300,
        maxBackoffMs: 10_000,
        stableResetMs: 150,
      });
      drainer.start();

      await waitFor(() => connections >= 6, 15_000);
      // Four instant deaths escalate the base to 4.8s (min delay 2.4s with
      // equal jitter). The stable connection resets it, so the post-stable
      // reconnect must arrive within the initial backoff (<= 300ms + margin),
      // not the escalated one.
      expect(reconnectAfterStableAt - stableClosedAt).toBeLessThan(1_500);
    } finally {
      await drainer?.stop();
      drainer = null;
      wss.close();
    }
  });

  it("honors Retry-After on a 429 handshake rejection", async () => {
    let attempts = 0;
    const server = createServer();
    server.on("upgrade", (_req, socket) => {
      attempts++;
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const drain: RelayDrain = {
      connectUrl: `ws://127.0.0.1:${port}/c/mailbox`,
      drainKey: "test-drain-key",
      targetAppId: "connector",
      targetPath: ["webhook"],
    };
    try {
      // Tight local backoff: if Retry-After were ignored, 1.6s would fit ~10
      // attempts; honoring the 1s header admits at most the initial try + one
      // retry (+ one more at the margin).
      drainer = new RelayDrainer([drain], async () => ({ status: 200 }), {
        initialBackoffMs: 100,
        maxBackoffMs: 400,
        stableResetMs: 60_000,
      });
      drainer.start();

      await new Promise((r) => setTimeout(r, 1_600));
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(attempts).toBeLessThanOrEqual(3);
      expect(drainer.getStatus()[0]?.lastTransportError).toMatch(/429/);
    } finally {
      await drainer?.stop();
      drainer = null;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("treats Retry-After as a floor: it never shortens an escalated backoff", async () => {
    let attempts = 0;
    const server = createServer();
    server.on("upgrade", (_req, socket) => {
      attempts++;
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const drain: RelayDrain = {
      connectUrl: `ws://127.0.0.1:${port}/c/mailbox`,
      drainKey: "test-drain-key",
      targetAppId: "connector",
      targetPath: ["webhook"],
    };
    try {
      // Local backoff (4s base, equal jitter → delay >= 2s) already exceeds the
      // 1s Retry-After. Honoring the header as an override would retry at
      // ~1-1.25s; as a floor, no retry may happen before 2s.
      drainer = new RelayDrainer([drain], async () => ({ status: 200 }), {
        initialBackoffMs: 4_000,
        maxBackoffMs: 8_000,
        stableResetMs: 60_000,
      });
      drainer.start();

      await new Promise((r) => setTimeout(r, 1_900));
      expect(attempts).toBe(1);
      // The retry does still happen, on the local schedule (within 4s + margin).
      await waitFor(() => attempts >= 2, 3_000);
    } finally {
      await drainer?.stop();
      drainer = null;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("buildRelayReplayRequest", () => {
  const drain: RelayDrain = {
    connectUrl: "ws://127.0.0.1:0/c/mb1",
    drainKey: "k",
    targetAppId: "connector",
    targetPath: ["webhook"],
  };
  const baseEvent: DrainEvent = {
    seq: 1,
    method: "POST",
    headers: {},
    body: null,
    path: "/h/mb1",
  };

  it("strips depositor-supplied reserved headers before stamping the drained header", () => {
    const req = buildRelayReplayRequest(drain, {
      ...baseEvent,
      headers: {
        "content-type": "application/json",
        "x-rome-internal-relay-drained": "spoofed",
        "X-Rome-Internal-Admin": "1",
      },
    });
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-rome-internal-admin"]).toBeUndefined();
    expect(req.headers["X-Rome-Internal-Admin"]).toBeUndefined();
    // The drainer's own marker is the only reserved header present, and is "1".
    expect(req.headers[RELAY_DRAINED_HEADER]).toBe("1");
  });

  it("carries the deposited query string through to the dispatched request", () => {
    const req = buildRelayReplayRequest(drain, {
      ...baseEvent,
      path: "/h/mb1?challenge=abc&hub.mode=subscribe",
    });
    expect(req.query.get("challenge")).toBe("abc");
    expect(req.query.get("hub.mode")).toBe("subscribe");
  });

  it("yields an empty query when the deposited path has none", () => {
    const req = buildRelayReplayRequest(drain, { ...baseEvent, path: "/h/mb1" });
    expect([...req.query.keys()]).toEqual([]);
  });

  it("delivers to the drain's resolved target path, not the deposited path", () => {
    const req = buildRelayReplayRequest(drain, { ...baseEvent, path: "/h/mb1?x=1" });
    expect(req.path).toEqual(["webhook"]);
  });
});
