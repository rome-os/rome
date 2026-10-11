// Per-tab client for the guardian live-events WebSocket (`/ws/events`). One
// socket carries every live topic so the dashboard's long-lived streams stay
// out of the browser's six-connection HTTP/1.1 pool (rome-os/rome#146). The
// wire protocol is documented in packages/core/src/live-events-server.ts.
import { z } from "zod";

/**
 * Where the client delivers events. `transport` is "socket" while the
 * WebSocket path works, and "fallback" once it never opened: callers then use
 * the topic's SSE route instead, which `useLiveEvents` does.
 */
export type LiveEventsTransport = "socket" | "fallback";

export interface LiveTopicListener {
  onEvent(event: string, data: unknown): void;
  /**
   * Events may have been missed, so resync. Fires after a reconnect once the
   * topic is subscribed again, and once when the client falls back to SSE.
   * Never fires for the listener's first subscription.
   */
  onReconnect(): void;
  /** The socket dropped. The client reconnects on its own. */
  onDrop(): void;
  /** The server refused or ended the subscription. The client does not retry it. */
  onRejected(message: string): void;
}

export interface LiveEventsClientOptions {
  /** Defaults to the global WebSocket, read when first needed. */
  WebSocket?: typeof WebSocket;
  /** Defaults to `/ws/events` on the page's host, over wss when the page is https. */
  url?: () => string;
  /** Failed opens before the first success that switch the tab to SSE. */
  maxFailedOpens?: number;
  openTimeoutMs?: number;
  /** How long the socket outlives its last subscription, so route changes reuse it. */
  idleCloseMs?: number;
  /** Delay before reconnect attempt `attempt` (1-based). */
  reconnectDelayMs?: (attempt: number) => number;
}

const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribed"), topic: z.string() }),
  z.object({
    type: z.literal("event"),
    topic: z.string(),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({ type: z.literal("error"), topic: z.string().optional(), message: z.string() }),
]);

const LIVE_EVENTS_PATH = "/ws/events";

function defaultUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${LIVE_EVENTS_PATH}`;
}

function globalWebSocket(): typeof WebSocket | undefined {
  return typeof WebSocket === "function" && typeof window !== "undefined" ? WebSocket : undefined;
}

function defaultReconnectDelayMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
}

interface TopicEntry {
  // The socket generation each listener last saw a `subscribed` ack on, or
  // null before its first one. An ack on a newer generation is a reconnect.
  listeners: Map<LiveTopicListener, number | null>;
  state: "idle" | "pending" | "subscribed" | "rejected";
}

export class LiveEventsClient {
  private readonly WebSocketImpl: typeof WebSocket | undefined;
  private readonly url: () => string;
  private readonly maxFailedOpens: number;
  private readonly openTimeoutMs: number;
  private readonly idleCloseMs: number;
  private readonly reconnectDelayMs: (attempt: number) => number;

  private readonly topics = new Map<string, TopicEntry>();
  private readonly transportListeners = new Set<() => void>();
  private transport: LiveEventsTransport | null = null;
  private socket: WebSocket | null = null;
  private socketOpen = false;
  private generation = 0;
  private everOpened = false;
  private failedAttempts = 0;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LiveEventsClientOptions = {}) {
    this.WebSocketImpl = options.WebSocket;
    this.url = options.url ?? defaultUrl;
    this.maxFailedOpens = options.maxFailedOpens ?? 3;
    this.openTimeoutMs = options.openTimeoutMs ?? 10_000;
    this.idleCloseMs = options.idleCloseMs ?? 5_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  }

  getTransport = (): LiveEventsTransport =>
    (this.transport ??= (this.WebSocketImpl ?? globalWebSocket()) ? "socket" : "fallback");

  /** Calls `listener` whenever `getTransport()` changes. Returns the unsubscribe. */
  onTransportChange = (listener: () => void): (() => void) => {
    this.transportListeners.add(listener);
    return () => {
      this.transportListeners.delete(listener);
    };
  };

  /**
   * Adds a listener for one topic and returns its release. Listeners on the
   * same topic share one server subscription, sent on the first add and
   * withdrawn on the last release. Call only while the transport is "socket".
   */
  subscribe(topic: string, listener: LiveTopicListener): () => void {
    let entry = this.topics.get(topic);
    if (!entry) {
      entry = { listeners: new Map(), state: "idle" };
      this.topics.set(topic, entry);
    }
    entry.listeners.set(listener, entry.state === "subscribed" ? this.generation : null);
    this.clearIdleTimer();
    if (entry.state === "idle" || entry.state === "rejected") {
      if (this.socketOpen) this.sendSubscribe(topic, entry);
      else entry.state = "idle";
    }
    this.ensureSocket();

    return () => {
      const current = this.topics.get(topic);
      if (!current?.listeners.delete(listener) || current.listeners.size > 0) return;
      this.topics.delete(topic);
      if (this.socketOpen && (current.state === "pending" || current.state === "subscribed")) {
        this.send({ type: "unsubscribe", topic });
      }
      if (this.topics.size === 0) this.scheduleIdleClose();
    };
  }

  private ensureSocket(): void {
    if (this.socket || this.reconnectTimer || this.transport === "fallback") return;
    const SocketImpl = this.WebSocketImpl ?? globalWebSocket();
    if (!SocketImpl) {
      this.fallBack();
      return;
    }
    let socket: WebSocket;
    try {
      socket = new SocketImpl(this.url());
    } catch (error) {
      console.error("Live events socket could not be created", { error: String(error) });
      this.fallBack();
      return;
    }
    this.socket = socket;
    this.socketOpen = false;
    this.openTimer = setTimeout(() => socket.close(), this.openTimeoutMs);
    socket.addEventListener("open", () => this.handleOpen(socket));
    socket.addEventListener("message", (event) => this.handleMessage(socket, event));
    socket.addEventListener("close", () => this.handleClose(socket));
  }

  private handleOpen(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.clearOpenTimer();
    this.socketOpen = true;
    this.everOpened = true;
    this.failedAttempts = 0;
    this.generation += 1;
    for (const [topic, entry] of this.topics) {
      if (entry.state !== "rejected") this.sendSubscribe(topic, entry);
    }
  }

  private handleMessage(socket: WebSocket, event: MessageEvent): void {
    if (socket !== this.socket) return;
    let raw: unknown;
    try {
      raw = JSON.parse(String(event.data));
    } catch {
      raw = undefined;
    }
    const parsed = serverMessageSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("Invalid live events message");
      return;
    }
    const message = parsed.data;
    if (message.type === "error" && message.topic === undefined) {
      console.error("Live events server error", { message: message.message });
      return;
    }
    const entry = this.topics.get(message.topic as string);
    if (!entry) return;

    if (message.type === "subscribed") {
      entry.state = "subscribed";
      for (const [listener, seen] of entry.listeners) {
        if (seen === this.generation) continue;
        entry.listeners.set(listener, this.generation);
        if (seen !== null) listener.onReconnect();
      }
    } else if (message.type === "event") {
      for (const listener of [...entry.listeners.keys()]) {
        listener.onEvent(message.event, message.data);
      }
    } else {
      entry.state = "rejected";
      for (const listener of [...entry.listeners.keys()]) listener.onRejected(message.message);
    }
  }

  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    const opened = this.socketOpen;
    this.clearOpenTimer();
    this.socket = null;
    this.socketOpen = false;
    for (const entry of this.topics.values()) {
      if (entry.state !== "rejected") entry.state = "idle";
    }
    if (!opened) this.failedAttempts += 1;
    if (!this.everOpened && this.failedAttempts >= this.maxFailedOpens) {
      this.fallBack();
      return;
    }
    if (opened) {
      for (const entry of this.topics.values()) {
        for (const listener of entry.listeners.keys()) listener.onDrop();
      }
    }
    if (this.topics.size === 0) return;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        if (this.topics.size > 0) this.ensureSocket();
      },
      this.reconnectDelayMs(Math.max(1, this.failedAttempts)),
    );
  }

  private fallBack(): void {
    this.transport = "fallback";
    // Listeners that waited through failed opens may have missed events.
    if (this.failedAttempts > 0) {
      for (const entry of this.topics.values()) {
        for (const listener of entry.listeners.keys()) listener.onReconnect();
      }
    }
    for (const listener of [...this.transportListeners]) listener();
  }

  private sendSubscribe(topic: string, entry: TopicEntry): void {
    entry.state = "pending";
    this.send({ type: "subscribe", topic });
  }

  private send(message: { type: "subscribe" | "unsubscribe"; topic: string }): void {
    this.socket?.send(JSON.stringify(message));
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.topics.size > 0) return;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const socket = this.socket;
      if (!socket) return;
      this.clearOpenTimer();
      this.socket = null;
      this.socketOpen = false;
      socket.close();
    }, this.idleCloseMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearOpenTimer(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }
}
