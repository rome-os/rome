import { describe, expect, it, rs } from "@rstest/core";
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
