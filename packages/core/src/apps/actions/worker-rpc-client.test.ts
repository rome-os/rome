import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { IpcRpcTimeoutError } from "./ipc.js";
import { callMain, setWorkerRpcInProcessDispatcher } from "./worker-rpc-client.js";

// These tests force the "no parent IPC channel" branch (`process.send`
// undefined) to exercise the main-process in-process fallback. The Rstest
// runner may itself be a forked child (where `process.send` exists), so we
// override it per-test and restore afterwards.
describe("callMain in-process fallback", () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  it("dispatches in-process when no IPC channel exists and a dispatcher is registered", async () => {
    process.send = undefined;
    const dispatcher = rs.fn(async () => ({ ok: true }));
    setWorkerRpcInProcessDispatcher(dispatcher);

    const result = await callMain("channels.discord.reloadConfig", { a: 1 });

    expect(result).toEqual({ ok: true });
    expect(dispatcher).toHaveBeenCalledWith("channels.discord.reloadConfig", { a: 1 });
  });

  it("enforces timeoutMs in the in-process path so a stalled dispatcher cannot hang forever", async () => {
    process.send = undefined;
    // A dispatcher that never settles — only the timeout can end the call.
    setWorkerRpcInProcessDispatcher(() => new Promise<never>(() => {}));

    await expect(callMain("slow.method", undefined, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      IpcRpcTimeoutError,
    );
  });

  it("throws the original error when no dispatcher is registered", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(null);

    await expect(callMain("some.method", {})).rejects.toThrow(
      "WorkerRPC: not running in a Node.js child process (method=some.method)",
    );
  });

  it("propagates errors thrown by the dispatcher", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async () => {
      throw new Error("boom");
    });

    await expect(callMain("some.method", {})).rejects.toThrow("boom");
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
