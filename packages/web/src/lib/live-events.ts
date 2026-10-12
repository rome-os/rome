// Per-tab client for the dashboard live-events WebSocket (`/ws/events`). One
// socket carries every live topic so the dashboard's long-lived streams stay
// out of the browser's six-connection HTTP/1.1 pool. The wire protocol is
// in @rome/api-types/live-events.
import {
  type LiveEventsClientMessage,
  liveEventsServerMessageSchema,
} from "@rome/api-types/live-events";

/**
 * Where the client delivers events. `transport` is "socket" while the
 * WebSocket path works, and "fallback" once it never opened: callers then use
 * the topic's SSE route instead, which `useLiveEvents` does. From "fallback"
 * the client probes the socket again on a slow timer and returns to "socket"
 * once one opens.
 */
export type LiveEventsTransport = "socket" | "fallback";

export interface LiveTopicListener {
  onEvent(event: string, data: unknown): void;
  /**
   * Events may have been missed, so resync. Fires after a reconnect once the
   * topic is subscribed again, once when the client falls back to SSE, and
   * once the topic is subscribed again after the socket comes back from the
   * fallback. Never fires for the listener's first subscription.
   */
  onReconnect(): void;
  /** The socket dropped. The client reconnects on its own. */
  onDrop(): void;
  /**
   * The server refused or ended the subscription. The client asks again only
   * after the socket reconnects or another listener subscribes to the topic.
   */
  onRejected(message: string): void;
}

export interface LiveEventsClientOptions {
  /** Defaults to the global WebSocket, read when first needed. */
  WebSocket?: typeof WebSocket;
  /** Defaults to `/ws/events` on the page's host, over wss when the page is https. */
  url?: () => string;
  /** Failed opens before the first success that switch the tab to SSE. */
  maxFailedOpens?: number;
  /**
   * How long opens must keep failing, from the first attempt, before the tab
   * switches to SSE. Fast failures while the backend restarts end within it.
   */
  minFallbackMs?: number;
  openTimeoutMs?: number;
  /** How long the socket outlives its last subscription, so route changes reuse it. */
  idleCloseMs?: number;
  /** Delay before reconnect attempt `attempt` (1-based). */
  reconnectDelayMs?: (attempt: number) => number;
  /** How long a socket stays open before its drop restarts the backoff at attempt 1. */
  stableOpenMs?: number;
  /** How often the client tries the socket again while on the SSE fallback. */
  reprobeMs?: number;
}

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

// Generations start at 1, so this never matches one. A listener holds it while
// its topic is rejected or the tab is on the SSE fallback, and the next ack on
// a later socket resyncs it.
const RESYNC_GENERATION = 0;

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
  private readonly minFallbackMs: number;
  private readonly openTimeoutMs: number;
  private readonly idleCloseMs: number;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly stableOpenMs: number;
  private readonly reprobeMs: number;

  private readonly topics = new Map<string, TopicEntry>();
  private readonly transportListeners = new Set<() => void>();
  private transport: LiveEventsTransport | null = null;
  private socket: WebSocket | null = null;
  private socketOpen = false;
  private generation = 0;
  private everOpened = false;
  private failedAttempts = 0;
  private firstAttemptAt: number | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private reprobeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LiveEventsClientOptions = {}) {
    this.WebSocketImpl = options.WebSocket;
    this.url = options.url ?? defaultUrl;
    this.maxFailedOpens = options.maxFailedOpens ?? 3;
    this.minFallbackMs = options.minFallbackMs ?? 15_000;
    this.openTimeoutMs = options.openTimeoutMs ?? 10_000;
    this.idleCloseMs = options.idleCloseMs ?? 5_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelayMs;
    this.stableOpenMs = options.stableOpenMs ?? 5_000;
    this.reprobeMs = options.reprobeMs ?? 60_000;
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
   * withdrawn on the last release. While the transport is "fallback" the
   * listener receives nothing until the socket comes back. The server replays
   * a topic's snapshot (the `chat.status` running set) only to the first
   * listener, so a snapshot topic keeps a single listener per tab.
   */
  subscribe(topic: string, listener: LiveTopicListener): () => void {
    let entry = this.topics.get(topic);
    if (!entry) {
      entry = { listeners: new Map(), state: "idle" };
      this.topics.set(topic, entry);
    }
    entry.listeners.set(
      listener,
      entry.state === "subscribed"
        ? this.generation
        : this.transport === "fallback"
          ? RESYNC_GENERATION
          : null,
    );
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
    this.openSocket();
  }

  private openSocket(): void {
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
      if (this.transport === "fallback") this.scheduleReprobe();
      else this.fallBack();
      return;
    }
    this.socket = socket;
    this.socketOpen = false;
    this.firstAttemptAt ??= Date.now();
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
    // A server or proxy that accepts and then drops at once would otherwise
    // reconnect at the shortest delay forever, resyncing every listener each time.
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.failedAttempts = 0;
    }, this.stableOpenMs);
    this.generation += 1;
    for (const [topic, entry] of this.topics) this.sendSubscribe(topic, entry);
    if (this.transport === "fallback") {
      this.transport = "socket";
      for (const listener of [...this.transportListeners]) listener();
      if (this.topics.size === 0) this.scheduleIdleClose();
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
    const parsed = liveEventsServerMessageSchema.safeParse(raw);
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
      for (const listener of [...entry.listeners.keys()]) {
        entry.listeners.set(listener, RESYNC_GENERATION);
        listener.onRejected(message.message);
      }
    }
  }

  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    const opened = this.socketOpen;
    this.clearOpenTimer();
    this.clearStableTimer();
    this.socket = null;
    this.socketOpen = false;
    for (const entry of this.topics.values()) entry.state = "idle";
    if (this.transport === "fallback") {
      this.scheduleReprobe();
      return;
    }
    this.failedAttempts += 1;
    if (
      !this.everOpened &&
      this.failedAttempts >= this.maxFailedOpens &&
      Date.now() - (this.firstAttemptAt ?? 0) >= this.minFallbackMs
    ) {
      this.fallBack();
      return;
    }
    if (opened) {
      for (const entry of this.topics.values()) {
        for (const listener of entry.listeners.keys()) listener.onDrop();
      }
    }
    if (this.topics.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.topics.size > 0) this.ensureSocket();
    }, this.reconnectDelayMs(this.failedAttempts));
  }

  private fallBack(): void {
    this.transport = "fallback";
    for (const entry of this.topics.values()) {
      for (const listener of entry.listeners.keys()) {
        entry.listeners.set(listener, RESYNC_GENERATION);
        // Listeners that waited through failed opens may have missed events.
        if (this.failedAttempts > 0) listener.onReconnect();
      }
    }
    for (const listener of [...this.transportListeners]) listener();
    if (this.failedAttempts > 0) this.scheduleReprobe();
  }

  // Leaving the fallback brings the tab's streams back off the HTTP pool after
  // a proxy starts passing upgrades or a backend restart outlasted the window.
  private scheduleReprobe(): void {
    if (this.reprobeTimer) return;
    this.reprobeTimer = setTimeout(() => {
      this.reprobeTimer = null;
      if (this.socket) return;
      if (this.topics.size === 0) this.scheduleReprobe();
      else this.openSocket();
    }, this.reprobeMs);
  }

  private sendSubscribe(topic: string, entry: TopicEntry): void {
    entry.state = "pending";
    this.send({ type: "subscribe", topic });
  }

  private send(message: LiveEventsClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // A probe in flight on the fallback closes itself once it opens idle.
      if (this.topics.size > 0 || this.transport === "fallback") return;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const socket = this.socket;
      if (!socket) return;
      this.clearOpenTimer();
      this.clearStableTimer();
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

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private clearOpenTimer(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }
}
