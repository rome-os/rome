import { encodeFrame, FRAME_TYPE, frameFits, isUuid, parseFrame, type Frame } from "./frame.js";
import { parseGatewayUrl } from "./gateway-url.js";
import { isJwt } from "./signer.js";
import {
  CLOSE,
  gatewayMessage,
  gatewayNotification,
  outboundEnvelope,
  type GatewayMessage,
  type GatewayNotification,
  type OutboundEnvelope,
} from "./protocol.js";

// Platform adapters must send authorization as a HEADER. Browser WebSocket
// cannot do that; do not fall back to a URL token or subprotocol credential.
export interface ClientSocket {
  readyState: number;
  send(data: string | Uint8Array): void;
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
/** How often a connection opened with a JWT asks the Gateway to extend its deadline. */
const REAUTH_INTERVAL_MS = 60_000;
const DEVICE_TOKEN = /^(?:romedev_|romemob_)[A-Za-z0-9_-]{43}$/;

export interface GatewayClientOptions {
  gatewayUrl: string;
  /**
   * Called on every connect and reconnect, and for each refresh of a JWT connection. Returns
   * a device token or a JWT. A JWT lives 60 seconds, so return a fresh one each time.
   */
  getToken(): string | Promise<string>;
  /** Tests only. Defaults to the global fetch. */
  fetch?: typeof fetch;
  createSocket(url: string, authorization: string): ClientSocket;
  onMessage(message: GatewayMessage): void;
  /** Receives parsed binary frames. Unparseable binary messages are dropped. */
  onFrame?(frame: Frame): void;
  onStatus?(status: ConnectionStatus): void;
  /**
   * A notification the Gateway sent for this device to show. Without a handler it is dropped,
   * like any other message the client does not know.
   */
  onNotification?(notification: GatewayNotification): void;
  random?(): number;
  beforeConnect?(): Promise<string | null>;
}

export function connectGateway(options: GatewayClientOptions) {
  let url = parseGatewayUrl(options.gatewayUrl);
  let stopped = false;
  let socket: ClientSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectingTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let reauthTimer: ReturnType<typeof setInterval> | undefined;
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
  // A 404 means the Gateway holds no connection for this instance, so this socket is dead
  // and closing it starts a reconnect. A 401 is left alone: the connection reaches its
  // deadline and the Gateway closes it with 4004.
  const refresh = async (current: ClientSocket, reauth: URL) => {
    try {
      const response = await (options.fetch ?? fetch)(reauth, {
        method: "POST",
        headers: { Authorization: `Bearer ${await options.getToken()}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (response.status === 404 && socket === current) current.close();
    } catch {}
  };
  const open = async () => {
    if (stopped) return;
    status("connecting");
    let current: ClientSocket;
    let token: string;
    try {
      const pending = options.getToken();
      token = typeof pending === "string" ? pending : await pending;
      if (!DEVICE_TOKEN.test(token) && !isJwt(token)) throw new Error("Invalid token format");
      if (options.beforeConnect) {
        const next = await options.beforeConnect();
        if (stopped) return;
        if (next === null) {
          stopped = true;
          status("revoked");
          return;
        }
        url = parseGatewayUrl(next);
      }
      current = options.createSocket(url.toString(), `Bearer ${token}`);
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
      clearInterval(reauthTimer);
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
      if (isJwt(token)) {
        const reauth = new URL(url);
        reauth.protocol = url.protocol === "wss:" ? "https:" : "http:";
        reauth.pathname = "/reauth";
        reauthTimer = setInterval(() => void refresh(current, reauth), REAUTH_INTERVAL_MS);
      }
    });
    current.addEventListener("message", ({ data }) => {
      if (stopped || socket !== current) return;
      if (typeof data !== "string") {
        const bytes =
          data instanceof Uint8Array
            ? data
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : null;
        const frame = bytes && parseFrame(bytes);
        if (frame) options.onFrame?.(frame);
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const notification = gatewayNotification(json);
      if (notification) {
        try {
          options.onNotification?.(notification);
        } catch {}
        return;
      }
      const message = gatewayMessage(json);
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
      try {
        socket.send(text);
        return true;
      } catch {
        return false;
      }
    },
    /**
     * Sends a request or response frame with the same no-queue semantics as send. Returns false
     * without sending a frame larger than MAX_FRAME_BYTES, so the connection stays open.
     */
    sendFrame(frame: Frame): boolean {
      if (stopped || !socket || socket.readyState !== 1) return false;
      if (!frameFits(frame.meta.byteLength, frame.body.byteLength)) return false;
      if (frame.type !== FRAME_TYPE.request && frame.type !== FRAME_TYPE.response) return false;
      if (!isUuid(frame.id) || !isUuid(frame.peer)) return false;
      try {
        socket.send(encodeFrame(frame));
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
      clearInterval(reauthTimer);
      const previous = socket;
      socket = null;
      previous?.close(1000, "client stopped");
      status("stopped");
    },
  };
}
