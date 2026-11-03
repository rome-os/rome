import { LiveEventsClient } from "@/lib/live-events";

/** In-memory WebSocket for live-events tests. Every event dispatches synchronously. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly sent: unknown[] = [];
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("no socket was created");
    return socket;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  /** The server accepted the upgrade. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  /** A server frame. Strings arrive verbatim, anything else as JSON. */
  receive(message: unknown): void {
    this.emit("message", { data: typeof message === "string" ? message : JSON.stringify(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export const asWebSocket = FakeWebSocket as unknown as typeof WebSocket;

/** A live-events client on `FakeWebSocket`, for component tests of the socket path. */
export function fakeSocketLiveEventsClient(): LiveEventsClient {
  return new LiveEventsClient({
    WebSocket: asWebSocket,
    url: () => "ws://rome.test/ws/events",
    reconnectDelayMs: () => 100,
  });
}

/** Opens the latest socket and acknowledges every topic it has asked for. Returns it. */
export function acceptLatestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.latest();
  socket.open();
  for (const message of socket.sent as Array<{ type: string; topic: string }>) {
    if (message.type === "subscribe") socket.receive({ type: "subscribed", topic: message.topic });
  }
  return socket;
}
