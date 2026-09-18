// Worker-side RPC client for calling main-process services.
//
// The main process owns live references to ChannelManager, RoutineEngine,
// and related services. Worker processes reach them over Node's child-process
// IPC channel via this client.

import { randomUUID } from "node:crypto";
import type { MessageReceipt, MessageDeliveryFailureKind } from "@rome-os/app-runtime";
import { DeliveryFailure } from "../connections/delivery/transport.js";

interface RpcRequestMessage {
  type: "rpc_request";
  clientId: string;
  id: number;
  method: string;
  params: unknown;
}

export interface RpcResponseMessage {
  type: "rpc_response";
  clientId: string;
  id: number;
  result?: unknown;
  error?: string;
  deliveryError?: {
    kind: MessageDeliveryFailureKind;
    receipts: MessageReceipt[];
    retryAfterMs?: number;
  };
}

export class WorkerRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`WorkerRPC timeout: ${method} (${timeoutMs}ms)`);
    this.name = "WorkerRpcTimeoutError";
  }
}

export class WorkerRpcDisconnectError extends Error {
  constructor() {
    super("WorkerRPC main process disconnected");
    this.name = "WorkerRpcDisconnectError";
  }
}

export class WorkerRpcSendError extends Error {
  constructor(method: string, cause: Error) {
    super(`WorkerRPC send failed: ${method} (${cause.message})`, { cause });
    this.name = "WorkerRpcSendError";
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  method: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// The wire protocol carries a `clientId` that the main process echoes back on
// responses, so each client instance only resolves responses from its own
// pending map — request ids never collide across client instances even though
// each numbers its requests independently from 1.
class WorkerRpcClient {
  private readonly clientId: string = randomUUID();
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private processHandlersInstalled = false;

  async call<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (!process.send) {
      // Main process: no parent IPC channel, but it directly holds the real
      // services. If a dispatcher is registered, run the call in-process
      // instead of failing. Worker processes always have `process.send` and
      // take the IPC path below — the two paths are mutually exclusive.
      const dispatcher = getInProcessDispatcher();
      if (dispatcher) {
        // Enforce the same deadline as the IPC path so both transports share
        // identical timeout semantics. Without this, callers like
        // AppManagerProxy (which set multi-minute deadlines for
        // apps.install/create/uninstall) would hang forever if an in-process
        // service operation stalls.
        const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new WorkerRpcTimeoutError(method, timeoutMs)), timeoutMs);
        });
        try {
          return (await Promise.race([dispatcher(method, params), timeout])) as T;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      throw new Error(`WorkerRPC: not running in a Node.js child process (method=${method})`);
    }

    this.ensureProcessHandlers();

    const id = this.nextId++;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkerRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        method,
      });

      const request: RpcRequestMessage = {
        type: "rpc_request",
        clientId: this.clientId,
        id,
        method,
        params,
      };
      process.send!(request, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(new WorkerRpcSendError(method, err));
        }
      });
    });
  }

  handleResponse(message: RpcResponseMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(
        message.deliveryError
          ? new DeliveryFailure(
              message.deliveryError.kind,
              message.error,
              message.deliveryError.receipts,
              message.deliveryError.retryAfterMs,
            )
          : new Error(message.error),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private ensureProcessHandlers(): void {
    if (this.processHandlersInstalled) return;
    this.processHandlersInstalled = true;

    process.on("message", (message: unknown) => {
      if (isWorkerRpcResponse(message) && message.clientId === this.clientId) {
        this.handleResponse(message);
      }
    });

    process.on("disconnect", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new WorkerRpcDisconnectError());
      }
      this.pending.clear();
    });
  }
}

let singleton: WorkerRpcClient | null = null;

export function getWorkerRpc(): WorkerRpcClient {
  if (!singleton) {
    singleton = new WorkerRpcClient();
  }
  return singleton;
}

// In-process dispatcher: lets `getWorkerRpc().call()` reach the real services
// when the caller runs in the main process (no `process.send`) — e.g. an
// agent turn proxied back to main, whose tool calls execute in-process there.
//
// Stored on `globalThis` under a `Symbol.for` key so registration survives any
// duplicate loading of this module (e.g. distinct ESM URLs of core source in
// tests); every copy observes the same dispatcher.
export type WorkerRpcInProcessDispatcher = (method: string, params: unknown) => Promise<unknown>;

const IN_PROCESS_DISPATCHER_KEY = Symbol.for("rome.workerRpc.inProcessDispatcher");

/**
 * Register (or clear, with `null`) the main-process dispatcher used as a
 * fallback when there is no parent IPC channel. Called once during main-process
 * wiring with a handler backed by the live WorkerRpcServer.
 */
export function setWorkerRpcInProcessDispatcher(
  dispatcher: WorkerRpcInProcessDispatcher | null,
): void {
  (globalThis as Record<symbol, unknown>)[IN_PROCESS_DISPATCHER_KEY] = dispatcher ?? undefined;
}

function getInProcessDispatcher(): WorkerRpcInProcessDispatcher | undefined {
  return (globalThis as Record<symbol, unknown>)[IN_PROCESS_DISPATCHER_KEY] as
    | WorkerRpcInProcessDispatcher
    | undefined;
}

export function isWorkerRpcResponse(message: unknown): message is RpcResponseMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: string }).type === "rpc_response" &&
    typeof (message as { clientId?: unknown }).clientId === "string"
  );
}
