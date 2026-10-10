import WebSocket from "ws";
import { isRecord } from "./actions.js";
import {
  DAEMON_PROTOCOL_VERSION,
  encodeBinaryMessage,
  MAX_LOCAL_MESSAGE_BYTES,
  parseBinaryMessage,
  parseDaemonStatus,
  type DaemonStatus,
} from "./daemon-protocol.js";

export class DaemonVersionError extends Error {
  constructor() {
    super(
      "The caller daemon uses an incompatible protocol. Stop it explicitly before restarting with this version.",
    );
  }
}

export class DaemonRequestError extends Error {
  readonly code = "unknown_outcome";
  constructor() {
    super(
      "Caller daemon connection failed. Execution outcome may be unknown; do not automatically retry.",
    );
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DaemonState {
  token: string;
  port: number;
  pid: number;
  protocolVersion?: number;
}

export class RpcConnection {
  private nextId = 0;
  private pending = new Map<
    string,
    {
      resolve(value: unknown, body: Uint8Array): void;
      reject(error: Error): void;
      progress?(params: Record<string, unknown>): void;
    }
  >();
  onNotification?: (method: string, params: unknown) => void;
  onClose?: () => void;

  constructor(readonly socket: WebSocket) {
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!this.open) return;
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30_000);
    heartbeat.unref();
    socket.on("pong", () => {
      alive = true;
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearInterval(heartbeat);
      for (const request of this.pending.values()) request.reject(new DaemonRequestError());
      this.pending.clear();
      this.onClose?.();
    });
    socket.on("message", (data, binary) => {
      let message: unknown;
      let body: Uint8Array = new Uint8Array();
      if (binary) {
        const parsed = parseBinaryMessage(
          Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data),
        );
        if (!parsed) {
          this.close();
          return;
        }
        ({ message, body } = parsed);
      } else {
        try {
          message = JSON.parse(data.toString());
        } catch {
          this.close();
          return;
        }
      }
      if (!isRecord(message) || message.jsonrpc !== "2.0") {
        this.close();
        return;
      }
      if (typeof message.method === "string" && !Object.hasOwn(message, "id")) {
        const params = message.params;
        // Transfer progress belongs to one request on this connection, not to subscribers.
        if (message.method === "events.transfer") {
          if (isRecord(params) && typeof params.requestId === "string")
            this.pending.get(params.requestId)?.progress?.(params);
          return;
        }
        this.onNotification?.(message.method, params);
        return;
      }
      const pending = typeof message.id === "string" ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      if (Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))
        pending.resolve(message.result, body);
      else if (
        !Object.hasOwn(message, "result") &&
        isRecord(message.error) &&
        Number.isInteger(message.error.code) &&
        typeof message.error.message === "string"
      )
        pending.reject(new RpcError(Number(message.error.code), message.error.message));
      else pending.reject(new DaemonRequestError());
    });
  }

  get open() {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * A timeoutMs of Infinity waits until the reply or the connection closes. `progress` receives
   * the params of `events.transfer` notifications for this request.
   */
  async request(
    method: string,
    params: unknown = {},
    timeoutMs = 85_000,
    progress?: (params: Record<string, unknown>) => void,
  ): Promise<unknown> {
    return (await this.submit(method, params, undefined, timeoutMs, progress)).result;
  }

  /**
   * Sends one binary message carrying `body`. A text reply resolves with an empty body.
   * Throws when `params` is not JSON.
   */
  async requestBinary(
    method: string,
    params: unknown,
    body: Uint8Array,
    timeoutMs = 85_000,
  ): Promise<{ result: unknown; body: Uint8Array }> {
    return this.submit(method, params, body, timeoutMs);
  }

  private submit(
    method: string,
    params: unknown,
    body: Uint8Array | undefined,
    timeoutMs: number,
    progress?: (params: Record<string, unknown>) => void,
  ): Promise<{ result: unknown; body: Uint8Array }> {
    if (!this.open) return Promise.reject(new DaemonRequestError());
    const id = String(++this.nextId);
    const message = { jsonrpc: "2.0", id, method, params };
    const data = body ? encodeBinaryMessage(message, body) : JSON.stringify(message);
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: { result: unknown; body: Uint8Array }) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value!);
      };
      // setTimeout treats Infinity as 1 ms, so an unbounded wait needs no timer at all.
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => finish(new DaemonRequestError()), timeoutMs)
        : undefined;
      this.pending.set(id, {
        resolve: (result, body) => finish(undefined, { result, body }),
        reject: (error) => finish(error),
        progress,
      });
      try {
        this.socket.send(data, { binary: Boolean(body) }, (error) => {
          if (error) finish(new DaemonRequestError());
        });
      } catch {
        finish(new DaemonRequestError());
      }
    });
  }

  close() {
    this.socket.terminate();
  }
}

/** Throws DaemonVersionError unless the daemon speaks `protocolVersion`. */
export async function connectRpc(
  state: DaemonState,
  signal?: AbortSignal,
  protocolVersion = DAEMON_PROTOCOL_VERSION,
): Promise<{ rpc: RpcConnection; status: DaemonStatus }> {
  signal?.throwIfAborted();
  const socket = new WebSocket(`ws://127.0.0.1:${state.port}/rpc`, {
    headers: { authorization: `Bearer ${state.token}` },
    handshakeTimeout: 1500,
    perMessageDeflate: false,
    maxPayload: MAX_LOCAL_MESSAGE_BYTES,
    followRedirects: false,
  });
  const rpc = new RpcConnection(socket);
  const abort = () => rpc.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("open", opened);
        socket.off("close", failed);
        socket.off("error", failed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new DaemonRequestError());
      };
      socket.once("open", opened);
      socket.once("close", failed);
      socket.once("error", failed);
      if (signal?.aborted) abort();
    });
    const value = await rpc.request("daemon.hello", { protocolVersion }, 1500);
    if (isRecord(value) && value.protocolVersion !== protocolVersion)
      throw new DaemonVersionError();
    const status = parseDaemonStatus(value);
    if (!status || status.pid !== state.pid) throw new DaemonRequestError();
    signal?.throwIfAborted();
    return { rpc, status };
  } catch (error) {
    rpc.close();
    if (error instanceof RpcError && error.code === -32002) throw new DaemonVersionError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
