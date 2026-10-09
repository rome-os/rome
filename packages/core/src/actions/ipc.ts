// Bidirectional action-worker IPC contract. Action model: docs/concepts/actions.md.
//
// IpcRpc builds two abstractions on a single Node.js IPC channel:
//   - call() / handle() for request/response in either direction
//   - openStream() / onStream() for named one-shot or long-running streams
//
// Wire format (5 message types):
//   - rpc_request  { reqId, method, params }
//   - rpc_response { reqId, result?, error? }
//   - stream_open  { channelId, name }
//   - sent_event   { channelId, value }
//   - stream_close { channelId, reason?, error? }

import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";

const log = createLogger("ipc");

export interface IpcRequestMessage {
  type: "rpc_request";
  reqId: string;
  method: string;
  params: unknown;
}

export interface IpcResponseMessage {
  type: "rpc_response";
  reqId: string;
  result?: unknown;
  error?: string;
}

export interface IpcStreamOpenMessage {
  type: "stream_open";
  channelId: string;
  name: string;
}

export interface IpcStreamEventMessage {
  type: "sent_event";
  channelId: string;
  value: unknown;
}

export interface IpcStreamCloseMessage {
  type: "stream_close";
  channelId: string;
  reason?: string;
  error?: string;
}

export type IpcMessage =
  | IpcRequestMessage
  | IpcResponseMessage
  | IpcStreamOpenMessage
  | IpcStreamEventMessage
  | IpcStreamCloseMessage;

export function isIpcMessage(message: unknown): message is IpcMessage {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { type?: unknown; reqId?: unknown; channelId?: unknown };
  switch (m.type) {
    case "rpc_request":
    case "rpc_response":
      return typeof m.reqId === "string";
    case "stream_open":
    case "sent_event":
    case "stream_close":
      return typeof m.channelId === "string";
    default:
      return false;
  }
}

export class IpcRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`IpcRpc timeout: ${method} (${timeoutMs}ms)`);
    this.name = "IpcRpcTimeoutError";
  }
}

export class IpcRpcDisconnectError extends Error {
  constructor() {
    super("IpcRpc peer disconnected");
    this.name = "IpcRpcDisconnectError";
  }
}

export class IpcStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcStreamError";
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
  method: string;
}

interface InboundStreamState<T> {
  name: string;
  channelId: string;
  values: T[];
  resolvers: Array<(item: IteratorResult<T>) => void>;
  done: boolean;
  error?: Error;
}

export interface IpcOutboundStream<T> {
  readonly name: string;
  readonly channelId: string;
  send(value: T): void;
  close(opts?: { error?: Error; reason?: string }): void;
}

export interface IpcInboundStream<T> {
  readonly name: string;
  readonly channelId: string;
  iter(): AsyncIterable<T>;
}

export interface IpcCallContext {
  /** Open an outbound stream owned by this side, addressed back to the caller. */
  openStream<T>(name: string): IpcOutboundStream<T>;
}

export interface IpcTransport {
  send(message: IpcMessage): void;
  onMessage(listener: (message: IpcMessage) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  /** Whether the channel is connected (for outbound sends). */
  readonly connected: boolean;
}

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Bidirectional RPC + streams over a Node IPC channel. Both sides construct
 * one of these and they exchange `IpcMessage`s through `IpcTransport.send`.
 *
 * `origin` is a short string ("main", "worker", etc.) used as a prefix in
 * channelId allocation so two sides can't collide.
 */
export class IpcRpc {
  private pending = new Map<string, PendingCall>();
  private handlers = new Map<string, (params: unknown, ctx: IpcCallContext) => Promise<unknown>>();
  private streamHandlers = new Map<
    string | RegExp,
    (stream: IpcInboundStream<unknown>) => Promise<void> | void
  >();
  private inboundStreams = new Map<string, InboundStreamState<unknown>>();
  private outboundChannels = new Set<string>();
  private disconnectHandlers = new Set<() => void>();
  private channelCounter = 0;
  private cleanupTransport?: () => void;
  private disconnected = false;

  constructor(
    private transport: IpcTransport,
    private origin: string,
    private options: {
      defaultTimeoutMs?: number;
      runInbound?: (callback: () => Promise<unknown>) => Promise<unknown>;
    } = {},
  ) {
    const offMessage = transport.onMessage((message) => {
      if (!isIpcMessage(message)) return;
      this.dispatch(message);
    });
    const offDisconnect = transport.onDisconnect(() => {
      this.handleDisconnect();
    });
    this.cleanupTransport = () => {
      offMessage();
      offDisconnect();
    };
  }

  /** Tear down listeners. The transport itself is not closed by this call. */
  dispose(): void {
    this.cleanupTransport?.();
    this.cleanupTransport = undefined;
    this.handleDisconnect();
  }

  /** Subscribe to peer disconnect. The callback runs at most once. */
  onDisconnect(handler: () => void): () => void {
    if (this.disconnected) {
      queueMicrotask(handler);
      return () => undefined;
    }
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  // RPC

  handle<Req = unknown, Res = unknown>(
    method: string,
    handler: (req: Req, ctx: IpcCallContext) => Promise<Res>,
  ): void {
    this.handlers.set(method, handler as (p: unknown, c: IpcCallContext) => Promise<unknown>);
  }

  async call<Req = unknown, Res = unknown>(
    method: string,
    params: Req,
    options?: { timeoutMs?: number | null },
  ): Promise<Res> {
    if (!this.transport.connected) {
      throw new IpcRpcDisconnectError();
    }
    const reqId = randomUUID();
    const timeoutMs =
      options?.timeoutMs === null
        ? null
        : (options?.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
    return await new Promise<Res>((resolve, reject) => {
      const timeout =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(reqId);
              reject(new IpcRpcTimeoutError(method, timeoutMs));
            }, timeoutMs);
      this.pending.set(reqId, {
        resolve: (value) => resolve(value as Res),
        reject,
        timeout,
        method,
      });
      try {
        this.transport.send({ type: "rpc_request", reqId, method, params });
      } catch (err) {
        if (timeout) clearTimeout(timeout);
        this.pending.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // Streams

  openStream<T>(name: string): IpcOutboundStream<T> {
    const channelId = `${this.origin}:${++this.channelCounter}`;
    this.outboundChannels.add(channelId);
    if (this.transport.connected) {
      this.transport.send({ type: "stream_open", channelId, name });
    }
    let closed = false;
    return {
      name,
      channelId,
      send: (value: T): void => {
        if (closed) return;
        if (!this.transport.connected) return;
        this.transport.send({ type: "sent_event", channelId, value });
      },
      close: (opts?: { error?: Error; reason?: string }): void => {
        if (closed) return;
        closed = true;
        this.outboundChannels.delete(channelId);
        if (!this.transport.connected) return;
        this.transport.send({
          type: "stream_close",
          channelId,
          reason: opts?.reason,
          error: opts?.error?.message,
        });
      },
    };
  }

  /**
   * Register a handler for inbound streams whose name matches `namePattern`.
   * String patterns match exactly; RegExp patterns match by `.test(name)`.
   */
  onStream<T>(
    namePattern: string | RegExp,
    handler: (stream: IpcInboundStream<T>) => Promise<void> | void,
  ): void {
    this.streamHandlers.set(
      namePattern,
      handler as (s: IpcInboundStream<unknown>) => Promise<void> | void,
    );
  }

  // Dispatch

  private async dispatch(message: IpcMessage): Promise<void> {
    switch (message.type) {
      case "rpc_request":
        await this.handleRequest(message);
        return;
      case "rpc_response":
        this.handleResponse(message);
        return;
      case "stream_open":
        this.handleStreamOpen(message);
        return;
      case "sent_event":
        this.handleStreamEvent(message);
        return;
      case "stream_close":
        this.handleStreamClose(message);
        return;
    }
  }

  private async handleRequest(message: IpcRequestMessage): Promise<void> {
    const handler = this.handlers.get(message.method);
    if (!handler) {
      this.transport.send({
        type: "rpc_response",
        reqId: message.reqId,
        error: `Unknown IPC method: ${message.method}`,
      });
      return;
    }
    const ctx: IpcCallContext = {
      openStream: <T>(name: string): IpcOutboundStream<T> => this.openStream<T>(name),
    };
    try {
      const invoke = () => handler(message.params, ctx);
      const result = this.options.runInbound
        ? await this.options.runInbound(invoke)
        : await invoke();
      this.transport.send({ type: "rpc_response", reqId: message.reqId, result });
    } catch (err) {
      this.transport.send({
        type: "rpc_response",
        reqId: message.reqId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleResponse(message: IpcResponseMessage): void {
    const pending = this.pending.get(message.reqId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pending.delete(message.reqId);
    if (message.error !== undefined) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleStreamOpen(message: IpcStreamOpenMessage): void {
    const handler = this.findStreamHandler(message.name);
    if (!handler) {
      this.transport.send({
        type: "stream_close",
        channelId: message.channelId,
        error: `No stream handler for: ${message.name}`,
      });
      return;
    }
    const state: InboundStreamState<unknown> = {
      name: message.name,
      channelId: message.channelId,
      values: [],
      resolvers: [],
      done: false,
    };
    this.inboundStreams.set(message.channelId, state);
    const inbound = this.buildInboundStream(state);
    Promise.resolve(handler(inbound)).catch(() => {
      // Stream handler errors are surfaced via the inbound iter; nothing
      // additional to do here other than not crash the dispatcher.
    });
  }

  private handleStreamEvent(message: IpcStreamEventMessage): void {
    const state = this.inboundStreams.get(message.channelId);
    if (!state || state.done) return;
    if (state.resolvers.length > 0) {
      const r = state.resolvers.shift()!;
      r({ value: message.value, done: false });
    } else {
      state.values.push(message.value);
    }
  }

  private handleStreamClose(message: IpcStreamCloseMessage): void {
    const state = this.inboundStreams.get(message.channelId);
    if (!state) return;
    state.done = true;
    if (message.error) {
      state.error = new IpcStreamError(message.error);
    }
    while (state.resolvers.length > 0) {
      const r = state.resolvers.shift()!;
      r({ value: undefined as never, done: true });
    }
    this.inboundStreams.delete(message.channelId);
  }

  private findStreamHandler(
    name: string,
  ): ((stream: IpcInboundStream<unknown>) => Promise<void> | void) | undefined {
    for (const [pattern, handler] of this.streamHandlers.entries()) {
      if (typeof pattern === "string") {
        if (pattern === name) return handler;
      } else if (pattern.test(name)) {
        return handler;
      }
    }
    return undefined;
  }

  private buildInboundStream<T>(state: InboundStreamState<unknown>): IpcInboundStream<T> {
    const stream: IpcInboundStream<T> = {
      name: state.name,
      channelId: state.channelId,
      iter(): AsyncIterable<T> {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<T>> {
                if (state.values.length > 0) {
                  return { value: state.values.shift() as T, done: false };
                }
                if (state.done) {
                  if (state.error) throw state.error;
                  return { value: undefined as never, done: true };
                }
                return await new Promise<IteratorResult<T>>((resolve) => {
                  state.resolvers.push(resolve as (item: IteratorResult<unknown>) => void);
                });
              },
            };
          },
        };
      },
    };
    return stream;
  }

  private handleDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    const err = new IpcRpcDisconnectError();
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
    for (const state of this.inboundStreams.values()) {
      state.done = true;
      state.error = err;
      while (state.resolvers.length > 0) {
        const r = state.resolvers.shift()!;
        r({ value: undefined as never, done: true });
      }
    }
    this.inboundStreams.clear();
    this.outboundChannels.clear();
    for (const handler of this.disconnectHandlers) handler();
    this.disconnectHandlers.clear();
  }
}

// Convenience transports

// A failed write is followed by `disconnect`, which rejects pending calls. The
// callback keeps the failure from surfacing as an unhandled `error` event.
function logSendFailure(message: IpcMessage): (err: Error | null) => void {
  return (err) => {
    if (err) log.warn("IPC send failed", { type: message.type, error: err.message });
  };
}

/** Build an IpcTransport over `process.send` / `process.on("message")` (worker side). */
export function createWorkerProcessTransport(): IpcTransport {
  return {
    get connected(): boolean {
      return !!process.send && process.connected !== false;
    },
    send(message: IpcMessage): void {
      if (!process.send) {
        throw new Error("createWorkerProcessTransport: not running in a Node child process");
      }
      process.send(message, logSendFailure(message));
    },
    onMessage(listener) {
      const handler = (message: unknown) => {
        if (isIpcMessage(message)) listener(message);
      };
      process.on("message", handler);
      return () => process.off("message", handler);
    },
    onDisconnect(listener) {
      const handler = () => listener();
      process.on("disconnect", handler);
      return () => process.off("disconnect", handler);
    },
  };
}

/** Build an IpcTransport over a `ChildProcess` (main side). */
export function createChildProcessTransport(
  child: import("node:child_process").ChildProcess,
): IpcTransport {
  return {
    get connected(): boolean {
      return child.connected;
    },
    send(message: IpcMessage): void {
      if (!child.connected) return;
      child.send(message, logSendFailure(message));
    },
    onMessage(listener) {
      const handler = (message: unknown) => {
        if (isIpcMessage(message)) listener(message);
      };
      child.on("message", handler);
      return () => child.off("message", handler);
    },
    onDisconnect(listener) {
      const handler = () => listener();
      child.on("disconnect", handler);
      child.on("exit", handler);
      return () => {
        child.off("disconnect", handler);
        child.off("exit", handler);
      };
    },
  };
}

let workerIpcSingleton: IpcRpc | null = null;
/**
 * Lazy worker-side IpcRpc bound to the parent process IPC channel. Returns
 * the same instance for the lifetime of the worker.
 */
export function getWorkerIpc(): IpcRpc {
  if (!workerIpcSingleton) {
    workerIpcSingleton = new IpcRpc(createWorkerProcessTransport(), "worker");
  }
  return workerIpcSingleton;
}
