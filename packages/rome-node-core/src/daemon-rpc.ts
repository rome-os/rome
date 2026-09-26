import WebSocket from "ws";
import { isRecord } from "./actions.js";
import {
  DAEMON_PROTOCOL_VERSION,
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
    { resolve(value: unknown): void; reject(error: Error): void }
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
      try {
        message = JSON.parse(data.toString());
      } catch {
        this.close();
        return;
      }
      if (binary || !isRecord(message) || message.jsonrpc !== "2.0") {
        this.close();
        return;
      }
      if (typeof message.method === "string" && !Object.hasOwn(message, "id")) {
        this.onNotification?.(message.method, message.params);
        return;
      }
      const pending = typeof message.id === "string" ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      if (Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))
        pending.resolve(message.result);
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

  request(method: string, params: unknown = {}, timeoutMs = 85_000): Promise<unknown> {
    if (!this.open) return Promise.reject(new DaemonRequestError());
    const id = String(++this.nextId);
    const text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new DaemonRequestError()), timeoutMs);
      this.pending.set(id, {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
      });
      try {
        this.socket.send(text, (error) => {
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

export async function connectRpc(
  state: DaemonState,
  signal?: AbortSignal,
): Promise<{ rpc: RpcConnection; status: DaemonStatus }> {
  signal?.throwIfAborted();
  const socket = new WebSocket(`ws://127.0.0.1:${state.port}/rpc`, {
    headers: { authorization: `Bearer ${state.token}` },
    handshakeTimeout: 1500,
    perMessageDeflate: false,
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
    const value = await rpc.request(
      "daemon.hello",
      { protocolVersion: DAEMON_PROTOCOL_VERSION },
      1500,
    );
    if (isRecord(value) && value.protocolVersion !== DAEMON_PROTOCOL_VERSION)
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
