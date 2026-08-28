import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  getWorkerRpc,
  setWorkerRpcInProcessDispatcher,
  WorkerRpcSendError,
  WorkerRpcTimeoutError,
} from "./worker-rpc-client.js";

// These tests force the "no parent IPC channel" branch (`process.send`
// undefined) to exercise the main-process in-process fallback. The Rstest
// runner may itself be a forked child (where `process.send` exists), so we
// override it per-test and restore afterwards.
describe("WorkerRpc in-process fallback", () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  it("dispatches in-process when no IPC channel exists and a dispatcher is registered", async () => {
    process.send = undefined;
    const dispatcher = rs.fn(async () => ({ ok: true }));
    setWorkerRpcInProcessDispatcher(dispatcher);

    const result = await getWorkerRpc().call("channels.discord.reloadConfig", { a: 1 });

    expect(result).toEqual({ ok: true });
    expect(dispatcher).toHaveBeenCalledWith("channels.discord.reloadConfig", { a: 1 });
  });

  it("enforces timeoutMs in the in-process path so a stalled dispatcher cannot hang forever", async () => {
    process.send = undefined;
    // A dispatcher that never settles — only the timeout can end the call.
    setWorkerRpcInProcessDispatcher(() => new Promise<never>(() => {}));

    await expect(
      getWorkerRpc().call("slow.method", undefined, { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(WorkerRpcTimeoutError);
  });

  it("throws the original error when no dispatcher is registered", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(null);

    await expect(getWorkerRpc().call("some.method")).rejects.toThrow(
      "WorkerRPC: not running in a Node.js child process (method=some.method)",
    );
  });

  it("propagates errors thrown by the dispatcher", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async () => {
      throw new Error("boom");
    });

    await expect(getWorkerRpc().call("some.method")).rejects.toThrow("boom");
  });

  it("shares the dispatcher across module copies via a Symbol.for global", () => {
    const dispatcher = rs.fn(async () => undefined);
    setWorkerRpcInProcessDispatcher(dispatcher);

    // A second physical copy of this module would read the same global slot.
    const slot = (globalThis as Record<symbol, unknown>)[
      Symbol.for("rome.workerRpc.inProcessDispatcher")
    ];
    expect(slot).toBe(dispatcher);
  });
});

describe("WorkerRpcSendError", () => {
  const originalSend = process.send;

  afterEach(() => {
    // getWorkerRpc() is a process-wide singleton and the in-process dispatcher
    // lives in a Symbol.for global slot — restore both so tests never leak
    // state into each other (matches the first describe's teardown).
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  it("wraps a process.send callback error, preserving the method and cause", async () => {
    // Stub a worker IPC channel whose send completes with an error, so `call`
    // takes the IPC path and hits the callback-error branch.
    const cause = new Error("EPIPE");
    process.send = ((_message: unknown, cb?: (err: Error | null) => void) => {
      cb?.(cause);
      return true;
    }) as unknown as typeof process.send;

    const err = await getWorkerRpc()
      .call("notify.send", {})
      .then(
        () => {
          throw new Error("expected the call to reject");
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(WorkerRpcSendError);
    expect((err as Error).message).toContain("notify.send");
    expect((err as Error).cause).toBe(cause);
  });

  it("does not wrap non-send failures as WorkerRpcSendError", async () => {
    // A dispatcher (in-process path) that throws yields a plain Error — this
    // guards the classification boundary a later caller relies on: only the
    // send-callback failure becomes WorkerRpcSendError.
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async () => {
      throw new Error("handler blew up");
    });

    const err = await getWorkerRpc()
      .call("some.method")
      .then(
        () => {
          throw new Error("expected the call to reject");
        },
        (e: unknown) => e,
      );

    expect(err).not.toBeInstanceOf(WorkerRpcSendError);
    expect((err as Error).message).toBe("handler blew up");
  });
});
