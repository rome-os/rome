import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { setTimeout as delay } from "node:timers/promises";
import { DeviceStatusReader } from "./devices-status.js";
import { actionError, type ActionResponse } from "./actions.js";
import type { ConnectionStatus } from "./client.js";

it("distinguishes replies, unavailable targets, timeouts, and revoked devices", async () => {
  const run = rs.fn(
    async (id: string): Promise<ActionResponse> =>
      id === "online"
        ? { type: "response", ok: true, result: {} }
        : actionError(id === "offline" ? "target_unavailable" : "unknown_outcome", "test"),
  );
  const reader = new DeviceStatusReader({
    getStatus: () => "online",
    list: async () => ({
      items: ["online", "offline", "unknown", "revoked"].map((id) => ({
        id,
        device_name: id,
        platform: "linux",
        revoked_at: id === "revoked" ? "2026-09-21" : null,
      })),
    }),
    run,
  });
  const result = await reader.read();
  expect(result.devices.map((device) => device.status)).toEqual([
    "connected",
    "not_connected",
    "unknown",
    "revoked",
  ]);
  expect(run).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenCalledWith("online", "system.info", {}, 3000);
});

it("passes on the audit status each device reports in system.info", async () => {
  const reader = new DeviceStatusReader({
    getStatus: () => "online",
    list: async () => ({ items: [{ id: "a" }, { id: "b" }, { id: "old" }] }),
    run: async (id: string): Promise<ActionResponse> => ({
      type: "response",
      ok: true,
      result:
        id === "a"
          ? { audit: { state: "unavailable", code: "io", message: "read-only" } }
          : id === "b"
            ? { audit: { state: "ok" } }
            : {},
    }),
  });
  expect((await reader.read()).devices.map((device) => device.audit)).toEqual([
    { state: "unavailable", code: "io", message: "read-only" },
    { state: "ok" },
    undefined,
  ]);
});

describe("shared device checks", () => {
  it("coalesces clients, limits concurrency, and invalidates cached results on connection loss", async () => {
    let connection: ConnectionStatus = "online";
    let active = 0;
    let maximum = 0;
    const list = rs.fn(async () => ({
      items: Array.from({ length: 12 }, (_, n) => ({ id: String(n) })),
    }));
    const run = rs.fn(async (): Promise<ActionResponse> => {
      active++;
      maximum = Math.max(maximum, active);
      await delay(5);
      active--;
      return { type: "response", ok: true, result: {} };
    });
    const reader = new DeviceStatusReader({ list, run, getStatus: () => connection });
    const results = await Promise.all([reader.read(), reader.read(), reader.read()]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(maximum).toBe(4);
    expect(results[0]).toEqual(results[1]);
    await reader.read();
    expect(run).toHaveBeenCalledTimes(12);
    connection = "retrying";
    reader.invalidate();
    expect((await reader.read()).devices.every((device) => device.status === "unknown")).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("never turns a failed Cloud list into an empty device count", async () => {
    const list = rs.fn(async () => {
      throw new Error("Cloud unavailable");
    });
    const reader = new DeviceStatusReader({ list, run: rs.fn(), getStatus: () => "online" });
    await expect(reader.read()).rejects.toThrow("Cloud unavailable");
    await expect(reader.read()).rejects.toThrow("Cloud unavailable");
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("stale snapshots", () => {
  beforeEach(() => {
    rs.useFakeTimers();
  });
  afterEach(() => {
    rs.useRealTimers();
  });

  /** Each Cloud list names the device after its round. `hold` keeps a round's list waiting. */
  function rounds() {
    let round = 0;
    const held = new Map<number, () => void>();
    const failing = new Set<number>();
    const list = rs.fn(async () => {
      const n = ++round;
      if (held.has(n)) await new Promise<void>((resolve) => held.set(n, resolve));
      if (failing.has(n)) throw new Error("Cloud unavailable");
      return { items: [{ id: "a", device_name: `round ${n}` }] };
    });
    const reader = new DeviceStatusReader({
      list,
      run: async (): Promise<ActionResponse> => ({ type: "response", ok: true, result: {} }),
      getStatus: () => "online",
    });
    const name = async () => (await reader.read()).devices[0]?.name;
    return {
      list,
      reader,
      name,
      hold: (n: number) => held.set(n, () => undefined),
      release: (n: number) => held.get(n)?.(),
      fail: (n: number) => failing.add(n),
    };
  }

  it("answers with the last snapshot at once and refreshes it in the background", async () => {
    const { list, name, hold, release } = rounds();
    expect(await name()).toBe("round 1");
    await rs.advanceTimersByTimeAsync(9_999);
    expect(await name()).toBe("round 1");
    expect(list).toHaveBeenCalledTimes(1);

    await rs.advanceTimersByTimeAsync(1);
    hold(2);
    // The check of round 2 is still waiting on Cloud, yet both reads answer.
    expect(await Promise.all([name(), name()])).toEqual(["round 1", "round 1"]);
    expect(list).toHaveBeenCalledTimes(2);

    release(2);
    await rs.advanceTimersByTimeAsync(0);
    expect(await name()).toBe("round 2");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps the last snapshot when a background check fails", async () => {
    const { list, name, fail } = rounds();
    expect(await name()).toBe("round 1");
    await rs.advanceTimersByTimeAsync(10_000);
    fail(2);
    expect(await name()).toBe("round 1");
    await rs.advanceTimersByTimeAsync(0);
    // The snapshot is still stale, so the next read tries again.
    expect(await name()).toBe("round 1");
    await rs.advanceTimersByTimeAsync(0);
    expect(await name()).toBe("round 3");
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("waits after invalidate and ignores a check that started before it", async () => {
    const { list, reader, name, hold, release } = rounds();
    expect(await name()).toBe("round 1");
    await rs.advanceTimersByTimeAsync(10_000);
    hold(2);
    expect(await name()).toBe("round 1");

    // A removed device must not come back from the check that was already running.
    reader.invalidate();
    expect(await name()).toBe("round 3");
    release(2);
    await rs.advanceTimersByTimeAsync(0);
    expect(await name()).toBe("round 3");
    expect(list).toHaveBeenCalledTimes(3);
  });
});
