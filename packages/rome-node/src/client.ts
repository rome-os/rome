import {
  byteLength,
  CLOSE,
  gatewayMessage,
  MAX_CLIENT_BUFFER_BYTES,
  MAX_MESSAGE_BYTES,
  outboundEnvelope,
  type GatewayMessage,
  type OutboundEnvelope,
} from "./protocol.js";

// Platform adapters must send authorization as a HEADER. Browser WebSocket
// cannot do that; do not fall back to a URL token or subprotocol credential.
export interface ClientSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}
export type ConnectionStatus =
  | "connecting"
  | "online"
  | "retrying"
  | "revoked"
  | "superseded"
  | "stopped";
export interface GatewayClientOptions {
  gatewayUrl: string;
  deviceToken: string;
  createSocket(url: string, authorization: string): ClientSocket;
  onMessage(message: GatewayMessage): void;
  onStatus?(status: ConnectionStatus): void;
  random?(): number;
  beforeConnect?(): Promise<string | null>;
}

export function connectGateway(options: GatewayClientOptions) {
  let url = new URL(options.gatewayUrl);
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash)
    throw new Error("A credential-free WSS URL is required");
  if (!/^(?:romedev_|romemob_)[A-Za-z0-9_-]{43}$/.test(options.deviceToken))
    throw new Error("Invalid device token format");
  let stopped = false;
  let socket: ClientSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectingTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  const status = (value: ConnectionStatus) => options.onStatus?.(value);
  const schedule = () => {
    if (stopped || timer) return;
    status("retrying");
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6));
    // Never reset on an immediate open/close cycle (e.g. reconnect storms).
    timer = setTimeout(
      () => {
        timer = undefined;
        void open();
      },
      delay * (0.75 + (options.random ?? Math.random)() * 0.5),
    );
  };
  const open = async () => {
    if (stopped) return;
    status("connecting");
    let current: ClientSocket;
    try {
      if (options.beforeConnect) {
        const next = await options.beforeConnect();
        if (stopped) return;
        if (next === null) {
          stopped = true;
          status("revoked");
          return;
        }
        url = new URL(next);
        if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash)
          throw new Error("A credential-free WSS URL is required");
      }
      current = options.createSocket(url.toString(), `Bearer ${options.deviceToken}`);
    } catch {
      schedule();
      return;
    }
    socket = current;
    let finished = false;
    const finish = (code?: number) => {
      if (finished || socket !== current) return;
      finished = true;
      clearTimeout(connectingTimer);
      clearTimeout(stableTimer);
      socket = null;
      if (code === CLOSE.revoked || code === CLOSE.superseded) {
        stopped = true;
        status(code === CLOSE.revoked ? "revoked" : "superseded");
      } else schedule();
    };
    connectingTimer = setTimeout(() => {
      finish();
      current.close();
    }, 10_000);
    current.addEventListener("open", () => {
      if (stopped || socket !== current) {
        current.close();
        return;
      }
      clearTimeout(connectingTimer);
      stableTimer = setTimeout(() => {
        attempt = 0;
      }, 30_000);
      status("online");
    });
    current.addEventListener("message", ({ data }) => {
      if (
        stopped ||
        socket !== current ||
        typeof data !== "string" ||
        byteLength(data) > MAX_MESSAGE_BYTES
      )
        return;
      let message;
      try {
        message = gatewayMessage(JSON.parse(data));
      } catch {
        return;
      }
      if (message) options.onMessage(message);
    });
    current.addEventListener("close", ({ code }) => finish(code));
    current.addEventListener("error", () => {
      finish();
      current.close();
    });
  };
  void open();
  return {
    // No queue, retry, or automatic resend. Callers must handle false as a loss.
    send(envelope: OutboundEnvelope): boolean {
      if (stopped || !socket || socket.readyState !== 1 || !outboundEnvelope(envelope))
        return false;
      let text: string;
      try {
        text = JSON.stringify(envelope);
        // JSON serialization can remove payloads such as undefined/functions.
        if (!outboundEnvelope(JSON.parse(text))) return false;
      } catch {
        return false;
      }
      const size = byteLength(text);
      if (size > MAX_MESSAGE_BYTES) return false;
      if (socket.bufferedAmount + size > MAX_CLIENT_BUFFER_BYTES) {
        socket.close(CLOSE.outputLimit, "outbound buffer limit");
        return false;
      }
      try {
        socket.send(text);
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(connectingTimer);
      clearTimeout(stableTimer);
      const previous = socket;
      socket = null;
      previous?.close(1000, "client stopped");
      status("stopped");
    },
  };
}
