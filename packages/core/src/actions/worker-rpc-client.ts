// Worker-side calls into main-process services.
//
// The main process owns live references to ChannelManager, RoutineEngine,
// and related services. Worker processes reach them over the worker's IpcRpc
// channel; `WorkerRpcServer` answers on the main side.

import { getWorkerIpc, IpcRpcDisconnectError, IpcRpcTimeoutError } from "./ipc.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Call a main-process service method from an action body. */
export async function callMain<T = unknown>(
  method: string,
  params: unknown,
  options?: { timeoutMs?: number },
): Promise<T> {
  if (process.send) {
    return await getWorkerIpc().call<unknown, T>(method, params, options);
  }
  // Main process: no parent IPC channel, but it directly holds the real
  // services, so run the call in-process under the same deadline.
  const dispatcher = getInProcessDispatcher();
  if (!dispatcher) {
    throw new Error(`WorkerRPC: not running in a Node.js child process (method=${method})`);
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IpcRpcTimeoutError(method, timeoutMs)), timeoutMs);
  });
  try {
    return (await Promise.race([dispatcher(method, params), timeout])) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a call failed in transport, so main may or may not have run it. */
export function isTransportUncertain(err: unknown): boolean {
  return err instanceof IpcRpcTimeoutError || err instanceof IpcRpcDisconnectError;
}

// In-process dispatcher: lets `callMain()` reach the real services when the
// caller runs in the main process (no `process.send`), e.g. an agent turn
// proxied back to main, whose tool calls execute in-process there.
//
// Stored on `globalThis` under a `Symbol.for` key so registration survives any
// duplicate loading of this module (e.g. distinct ESM URLs of core source in
// tests); every copy observes the same dispatcher.
export type WorkerRpcInProcessDispatcher = (method: string, params: unknown) => Promise<unknown>;

const IN_PROCESS_DISPATCHER_KEY = Symbol.for("rome.workerRpc.inProcessDispatcher");

/**
 * Register (or clear, with `null`) the main-process dispatcher used when there
 * is no parent IPC channel. Called once during main-process wiring with a
 * handler backed by the live WorkerRpcServer.
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
