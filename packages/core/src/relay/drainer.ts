import { WebSocket, type RawData } from "ws";
import { createLogger } from "../logger.js";
import type { RomeAppCaller } from "../apps/api.js";
import { RELAY_DRAINED_HEADER, stripInternalHeaders, type ServerFrame } from "./protocol.js";

const log = createLogger("relay-drainer");

// A socket that misses one pong is terminated at the next ping, so a stalled
// path is dropped within two intervals instead of when TCP gives up minutes
// later. While the relay keeps such a socket, its mailbox DO cannot hibernate
// and bills Durable Object duration.
const PING_INTERVAL_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const DELIVERY_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
// Node clamps larger setTimeout values to 1ms. Keep status and the scheduled
// timer aligned instead of turning a large Retry-After into an immediate retry.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Reconnect timing. Injectable so reconnect tests can compress the schedule. */
export interface DrainTiming {
  initialBackoffMs: number;
  maxBackoffMs: number;
  /**
   * How long a socket must stay open before its backoff resets. Resetting on
   * `open` would turn an opens-then-immediately-dies failure mode — a broken
   * proxy, or two drainers holding the same credentials being alternately
   * "superseded" by the mailbox DO — into a ~1/s reconnect storm that burns
   * the relay's Cloudflare request quota (observed live: ~80k connects/day
   * from one mailbox). A connection only proves itself by staying up.
   */
  stableResetMs: number;
}

export const DEFAULT_DRAIN_TIMING: DrainTiming = {
  initialBackoffMs: 1_000,
  // A short ceiling still draws thousands of connects/day per instance while
  // the relay is unreachable. A webhook backlog is fully replayed on
  // reconnect, so a long ceiling costs only delivery latency while offline,
  // not data.
  maxBackoffMs: 15 * 60_000,
  stableResetMs: 60_000,
};

// 4xx statuses that are commonly transient — the consumer may accept the same
// payload on a later replay (timeout, lock conflict, rate limit). Treat these
// like a 5xx (bounded retry, then block un-acked) instead of dropping. Every
// other 4xx is a terminal client error (e.g. 401 bad signature) and is acked so
// it doesn't poison-loop and head-of-line block every later seq.
const RETRYABLE_4XX = new Set([408, 409, 425, 429]);

export interface RelayDrain {
  /** wss URL of the mailbox drain endpoint, e.g. `wss://relay/c/{mailboxId}`. */
  connectUrl: string;
  /** Drain key proving the right to drain this mailbox (presented as `Authorization: Bearer`). */
  drainKey: string;
  /** App id whose api handler receives drained webhooks (e.g. "connector"). */
  targetAppId: string;
  /** App-api sub-path the webhook is delivered to (e.g. ["webhook"]). */
  targetPath: string[];
}

export interface DrainEvent {
  seq: number;
  method: string;
  headers: Record<string, string>;
  /** Raw request body, or null when the original deposit had no body. */
  body: Uint8Array | null;
  path: string;
}

/**
 * Delivers a drained event to its local target. `status` follows HTTP
 * semantics: only 2xx counts as handled (ack); a terminal 4xx is permanently
 * rejected (ack to drop and avoid a poison-redelivery loop); everything else —
 * 5xx, a transient 4xx (see RETRYABLE_4XX: 408/409/425/429), a non-2xx like a
 * 3xx that no app code handled, or a thrown error — is retried a bounded number
 * of times on the same socket. It then blocks, still un-acked, until a guardian
 * explicitly resumes it. A transport reconnect preserves the current delivery
 * retry budget and deadline.
 */
export type DeliverFn = (
  drain: RelayDrain,
  event: DrainEvent,
) => Promise<{ status: number; retryAfter?: string | null }>;

/** App-api request shape (structurally `RomeAppApiRequest`) the replay dispatches. */
export interface RelayReplayRequest {
  method: string;
  path: string[];
  headers: Record<string, string>;
  query: URLSearchParams;
  body?: Uint8Array;
  caller: RomeAppCaller;
}

/**
 * Map a drained event onto an in-process app-api request. Two trust boundaries
 * are enforced here, since the depositor (the external webhook sender) controls
 * both the event headers and path:
 *   - reserved `x-rome-internal-*` headers are stripped before stamping
 *     RELAY_DRAINED_HEADER, so a depositor can't forge an internal-only header;
 *   - the deposited query string is carried through (handlers that verify a
 *     challenge param on the query would otherwise see a malformed request).
 */
export function buildRelayReplayRequest(drain: RelayDrain, event: DrainEvent): RelayReplayRequest {
  const headers = { ...event.headers };
  stripInternalHeaders(headers);
  headers[RELAY_DRAINED_HEADER] = "1";
  const queryStart = event.path.indexOf("?");
  return {
    method: event.method,
    path: drain.targetPath,
    headers,
    query: new URLSearchParams(queryStart >= 0 ? event.path.slice(queryStart + 1) : ""),
    body: event.body ?? undefined,
    // The depositor is an external webhook sender — never a session-bearing
    // browser — so a replay is always anonymous, regardless of what identity
    // headers the depositor tried to send (stripped above).
    caller: { kind: "anonymous" },
  };
}

export interface RelayFailure {
  /** Null when the failure happened before an event was received (for example, a WS handshake). */
  seq: number | null;
  status: number | null;
  error: string | null;
}

/** Live health of one drain connection, surfaced to the dashboard. */
export interface RelayDrainStatus {
  targetAppId: string;
  targetPath: string[];
  connected: boolean;
  lastTransportError: string | null;
  /** Epoch ms the current socket opened; null while disconnected. */
  connectedSince: number | null;
  /** Epoch ms of the next transport reconnect; null unless disconnected. */
  nextReconnectAt: number | null;
  /** Relay queue length reported by the latest `ready` frame; not a live count. */
  backlog: number | null;
  /** Epoch ms of the last event an app handler processed (2xx → acked). */
  lastEventAt: number | null;
  /**
   * Events processed (2xx → acked) over this connection's lifetime. Resets on
   * reload()/restart — a flow indicator for the health widget, not an audit log.
   */
  deliveredCount: number;
  /** A bounded retry currently waiting to re-deliver this same event. */
  retry: {
    seq: number;
    nextAttemptAt: number;
  } | null;
  /** Retry budget exhausted; the event remains un-acked until it is resumed. */
  blocked: {
    seq: number;
  } | null;
  /** Latest non-2xx or thrown delivery, including terminal drops. */
  lastDeliveryFailure: RelayFailure | null;
}

/**
 * Maintains one persistent WebSocket per configured drain to the webhook relay,
 * replaying buffered + live webhooks into local app handlers.
 *
 * The relay buffers while we are offline and replays every un-acked event in
 * `seq` order on each (re)connect, so this client only has to: deliver in order,
 * ack on success, and reconnect on drop. Delivery is at-least-once — the target
 * handler must be idempotent (the connector handler dedupes on `webhook-id`).
 */
export class RelayDrainer {
  private readonly connections: DrainConnection[] = [];

  constructor(
    private drains: RelayDrain[],
    private readonly deliver: DeliverFn,
    private readonly timing: DrainTiming = DEFAULT_DRAIN_TIMING,
  ) {}

  start(): void {
    if (this.connections.length > 0) {
      // Already started; starting again would open a second socket per drain and
      // double every delivery. Callers that want to re-point the drainer use
      // reload(), which stops the existing connections first.
      log.warn("relay drainer already started; ignoring duplicate start()");
      return;
    }
    for (const drain of this.drains) {
      const conn = new DrainConnection(drain, this.deliver, this.timing);
      this.connections.push(conn);
      conn.start();
    }
  }

  /**
   * Tear down the current connections and reconnect from a new drain list.
   * Backs the runtime settings UI: when the guardian saves or clears relay
   * credentials, the live connection is rebuilt without a process restart
   * (mirrors `ChannelManager.reload`). Passing `[]` fully disconnects.
   */
  async reload(drains: RelayDrain[]): Promise<void> {
    await this.stop();
    this.drains = drains;
    this.start();
  }

  /** Per-connection health for the dashboard. Empty when not configured. */
  getStatus(): RelayDrainStatus[] {
    return this.connections.map((conn) => conn.status());
  }

  /**
   * Re-arm any delivery whose short retry budget was exhausted. This is a
   * guardian-controlled recovery action: it never discards the un-acked event.
   */
  resumeBlocked(): boolean {
    return this.connections.some((conn) => conn.resumeBlocked());
  }

  async stop(): Promise<void> {
    await Promise.all(this.connections.map((conn) => conn.stop()));
    this.connections.length = 0;
  }
}

class DrainConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  // Arms on open, fires after timing.stableResetMs: only then has the
  // connection proven stable enough to earn a backoff reset.
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  // A retry or blocked event deliberately holds this queue. The relay prunes
  // every row <= the acked seq, so no later event may overtake a failed one.
  private queue: Promise<void> = Promise.resolve();
  private deliveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private deliveryRetryWaiter: ((completed: boolean) => void) | null = null;
  private blockedWaiter: ((resumed: boolean) => void) | null = null;
  // Surfaced to the dashboard via RelayDrainer.getStatus().
  private connected = false;
  private lastTransportError: string | null = null;
  private connectedSince: number | null = null;
  private nextReconnectAt: number | null = null;
  private backlog: number | null = null;
  private lastEventAt: number | null = null;
  private deliveredCount = 0;
  // One un-acked event owns the queue. Keeping its retry budget independent of
  // the WebSocket makes a transport flap unable to reset bounded retries.
  private delivery: { seq: number; attempts: number; retryAt: number | null } | null = null;
  private blocked: RelayDrainStatus["blocked"] = null;
  private lastDeliveryFailure: RelayDrainStatus["lastDeliveryFailure"] = null;

  constructor(
    private readonly drain: RelayDrain,
    private readonly deliver: DeliverFn,
    private readonly timing: DrainTiming,
  ) {
    this.backoffMs = timing.initialBackoffMs;
  }

  start(): void {
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    // Let a delivery that is already in flight finish and ack on the still-open
    // socket. Retry waits and blocked gates are cancelled above, so shutdown
    // never waits through a retry budget or for a guardian to press Resume.
    await this.queue.catch(() => {});
    this.connected = false;
    this.connectedSince = null;
    try {
      this.ws?.close(1000);
    } catch {
      // already closing
    }
    this.ws = null;
  }

  resumeBlocked(): boolean {
    if (this.stopped || !this.blocked) return false;
    this.blocked = null;
    this.blockedWaiter?.(true);
    return true;
  }

  status(): RelayDrainStatus {
    return {
      targetAppId: this.drain.targetAppId,
      targetPath: this.drain.targetPath,
      connected: this.connected,
      lastTransportError: this.lastTransportError,
      connectedSince: this.connectedSince,
      nextReconnectAt: this.nextReconnectAt,
      backlog: this.backlog,
      lastEventAt: this.lastEventAt,
      deliveredCount: this.deliveredCount,
      retry:
        this.delivery?.retryAt != null
          ? { seq: this.delivery.seq, nextAttemptAt: this.delivery.retryAt }
          : null,
      blocked: this.blocked,
      lastDeliveryFailure: this.lastDeliveryFailure,
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.nextReconnectAt = null;
    // The relay accepts the drain key on the Authorization header only, and a
    // connect URL is a bare `/c/{mailboxId}` — the worker reads nothing off the
    // query. Strip any query (e.g. a stale `?t=` credential) and `user:pass@`
    // userinfo a pasted connectUrl may carry, so no secret ever lands in
    // Cloudflare access logs or rides the handshake as Basic auth; this mirrors
    // sanitizeDrainUrl, so the persisted and dialed URLs agree.
    const url = new URL(this.drain.connectUrl);
    url.search = "";
    url.username = "";
    url.password = "";
    const ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${this.drain.drainKey}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.connectedSince = Date.now();
      this.lastTransportError = null;
      this.startPing(ws);
      // Deliberately NOT resetting backoff here — see DrainTiming.stableResetMs.
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.backoffMs = this.timing.initialBackoffMs;
      }, this.timing.stableResetMs);
      log.info("relay drain connected", { target: this.drain.targetAppId });
    });
    ws.on("message", (data: RawData) => this.enqueue(data.toString(), ws));
    ws.on("error", (err: Error) => {
      if (this.ws !== ws) return;
      this.lastTransportError = err.message;
      log.warn("relay drain socket error", { target: this.drain.targetAppId, error: err.message });
    });
    // The relay refused the upgrade with a plain HTTP response (`ws` then emits
    // neither `open` nor `close`). A 429 carries Retry-After from the relay's
    // connect rate limit — honor it exactly instead of retrying on our own
    // schedule; everything else falls back to normal backoff.
    ws.on("unexpected-response", (_req, res) => {
      if (this.ws !== ws) return;
      this.lastTransportError = `relay refused connect: HTTP ${res.statusCode}`;
      log.warn("relay drain connect refused", {
        target: this.drain.targetAppId,
        status: res.statusCode,
      });
      res.resume(); // drain and free the response stream
      // terminate() below fires a spurious "closed before connection
      // established" error; swallow it so lastTransportError keeps the status.
      ws.removeAllListeners("error");
      ws.on("error", () => {});
      try {
        ws.terminate();
      } catch {
        // handshake socket already gone
      }
      if (this.ws === ws) this.ws = null;
      const retryAfterSec =
        res.statusCode === 429 ? Number(res.headers["retry-after"]) : Number.NaN;
      const minDelayMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : undefined;
      if (!this.stopped) this.scheduleReconnect(minDelayMs);
    });
    ws.on("close", (code: number, reason: Buffer) => {
      if (this.ws !== ws) return;
      log.info("relay drain closed", {
        target: this.drain.targetAppId,
        code,
        reason: reason.toString(),
        connectedForMs: this.connectedSince === null ? null : Date.now() - this.connectedSince,
      });
      this.connected = false;
      this.connectedSince = null;
      this.stopPing();
      this.stopStableTimer();
      this.ws = null;
      // An un-acked event will replay on the new socket. Never let an old
      // in-memory retry ack it after that new connection is established.
      this.cancelDeliveryWaits(true);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private enqueue(raw: string, source: WebSocket): void {
    this.queue = this.queue
      .then(() => this.handleFrame(raw, source))
      .catch((err) =>
        log.error("relay drain frame handler crashed", {
          target: this.drain.targetAppId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  private async handleFrame(raw: string, source: WebSocket): Promise<void> {
    // A backlog enqueued from an old socket can still be sitting in `queue` when
    // the guardian disconnects, reloads, or reconnects. Never replay it into the
    // new socket generation.
    if (this.stopped || this.ws !== source) return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return; // ignore non-JSON frames
    }
    if (frame.type === "ready") {
      this.backlog = frame.backlog;
      log.info("relay drain ready", { target: this.drain.targetAppId, backlog: frame.backlog });
      return;
    }
    if (frame.type !== "event") return; // unknown frame type

    const event: DrainEvent = {
      seq: frame.seq,
      method: frame.method,
      headers: frame.headers,
      body: frame.body != null ? Buffer.from(frame.body, "base64") : null,
      path: frame.path,
    };
    if (this.delivery && this.delivery.seq !== event.seq) return;
    // The previous socket may have closed after the retry budget was exhausted.
    // Keep the poison event blocked across that transport reconnect — otherwise
    // a flapping relay could silently turn bounded delivery retries into an
    // unbounded loop. Later frames remain behind this lowest un-acked seq.
    if (this.blocked) {
      if (event.seq !== this.blocked.seq) return;
      const resumed = await this.waitForResume();
      if (!resumed || this.stopped || !this.isCurrentSocket(source)) return;
    }
    await this.deliverWithRetries(event, source);
  }

  private async deliverWithRetries(event: DrainEvent, source: WebSocket): Promise<void> {
    const delivery =
      this.delivery?.seq === event.seq
        ? this.delivery
        : { seq: event.seq, attempts: 0, retryAt: null };
    this.delivery = delivery;

    if (delivery.retryAt != null) {
      const remainingDelayMs = Math.max(0, delivery.retryAt - Date.now());
      if (remainingDelayMs > 0) {
        const completed = await this.waitForDeliveryRetry(remainingDelayMs);
        if (!completed || this.stopped || !this.isCurrentSocket(source)) return;
      }
      delivery.retryAt = null;
    }

    while (!this.stopped && this.isCurrentSocket(source)) {
      delivery.attempts += 1;
      let status: number | null = null;
      let error: string | null = null;
      let retryAfter: string | null | undefined;

      try {
        const result = await this.deliver(this.drain, event);
        status = result.status;
        retryAfter = result.retryAfter;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      if (status !== null && status >= 200 && status < 300) {
        this.deliveredCount += 1;
        this.lastEventAt = Date.now();
        this.delivery = null;
        this.blocked = null;
        this.ack(event.seq, source);
        return;
      }

      const now = Date.now();
      this.lastDeliveryFailure = { seq: event.seq, status, error };

      if (status !== null && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
        // Terminal client error (e.g. 401 bad signature). Ack to drop it,
        // otherwise the same poison event blocks every later seq forever.
        this.delivery = null;
        log.warn("relay drain delivery rejected (terminal) — dropping", {
          target: this.drain.targetAppId,
          seq: event.seq,
          status,
        });
        this.ack(event.seq, source);
        return;
      }

      // A delivery already in flight is allowed to finish during stop(), but it
      // must not start a new retry after shutdown/reload begins.
      if (this.stopped || !this.isCurrentSocket(source)) return;

      const retryIndex = delivery.attempts - 1;
      const retryDelay = DELIVERY_RETRY_DELAYS_MS[retryIndex];
      if (retryDelay === undefined) {
        this.delivery = null;
        this.blocked = {
          seq: event.seq,
        };
        log.error("relay drain delivery blocked after bounded retries", {
          target: this.drain.targetAppId,
          seq: event.seq,
          attempts: delivery.attempts,
          status,
          error,
        });
        const resumed = await this.waitForResume();
        if (!resumed || this.stopped || !this.isCurrentSocket(source)) return;
        delivery.attempts = 0;
        delivery.retryAt = null;
        this.delivery = delivery;
        continue;
      }

      const delayMs = Math.max(retryDelay, retryAfterMs(retryAfter));
      delivery.retryAt = now + delayMs;
      log.warn("relay drain delivery retry scheduled", {
        target: this.drain.targetAppId,
        seq: event.seq,
        attempt: retryIndex + 1,
        status,
        error,
        delayMs,
      });
      const completed = await this.waitForDeliveryRetry(delayMs);
      if (!completed || this.stopped || !this.isCurrentSocket(source)) return;
      delivery.retryAt = null;
    }
  }

  private isCurrentSocket(source: WebSocket): boolean {
    return this.ws === source && source.readyState === WebSocket.OPEN;
  }

  private ack(seq: number, source: WebSocket): void {
    if (!this.isCurrentSocket(source)) return;
    try {
      source.send(JSON.stringify({ type: "ack", seq }));
    } catch {
      // socket gone; event stays un-acked and replays on the next reconnect
    }
  }

  private waitForDeliveryRetry(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (completed: boolean) => {
        if (timer) clearTimeout(timer);
        if (this.deliveryRetryTimer === timer) this.deliveryRetryTimer = null;
        if (this.deliveryRetryWaiter === finish) this.deliveryRetryWaiter = null;
        resolve(completed);
      };
      this.deliveryRetryWaiter = finish;
      timer = setTimeout(() => finish(true), delayMs);
      this.deliveryRetryTimer = timer;
    });
  }

  private waitForResume(): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (resumed: boolean) => {
        if (this.blockedWaiter === finish) this.blockedWaiter = null;
        resolve(resumed);
      };
      this.blockedWaiter = finish;
    });
  }

  private cancelDeliveryWaits(preserveDeliveryState = false): void {
    this.deliveryRetryWaiter?.(false);
    this.blockedWaiter?.(false);
    if (!preserveDeliveryState) {
      this.delivery = null;
      this.blocked = null;
    }
  }

  private scheduleReconnect(minDelayMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    // Equal jitter (half fixed, half random): decorrelates a fleet reconnecting
    // after a relay deploy without collapsing the lower bound to zero, so the
    // schedule stays testable and a storm can never tighten below base/2.
    const base = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.timing.maxBackoffMs);
    const localDelay = base / 2 + Math.random() * (base / 2);
    // A server Retry-After is a FLOOR, never a shortcut: repeated 429s must not
    // pull an escalated local backoff down to the header value (which would pin
    // every rejected client to the same cadence and re-create the storm this
    // backoff exists to prevent). While the floor binds, stretch it by up to
    // 25% so rejected clients still decorrelate.
    const delay =
      minDelayMs === undefined
        ? localDelay
        : Math.max(minDelayMs * (1 + Math.random() * 0.25), localDelay);
    this.nextReconnectAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(ws: WebSocket): void {
    this.stopPing();
    let awaitingPong = false;
    ws.on("pong", () => {
      awaitingPong = false;
    });
    this.pingTimer = setInterval(() => {
      if (awaitingPong) {
        log.warn("relay drain missed a heartbeat; dropping the socket", {
          target: this.drain.targetAppId,
        });
        // terminate() emits close, which schedules the reconnect.
        ws.terminate();
        return;
      }
      awaitingPong = true;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private stopStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    this.stopStableTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.nextReconnectAt = null;
    this.cancelDeliveryWaits();
  }
}

function retryAfterMs(value: string | null | undefined): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_TIMER_DELAY_MS, Math.ceil(seconds * 1_000));
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.min(MAX_TIMER_DELAY_MS, Math.max(0, retryAt - Date.now()))
    : 0;
}
