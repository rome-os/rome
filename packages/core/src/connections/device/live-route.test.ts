import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/db.js";
import { connectStep } from "./connect-step.js";
import {
  askingDeviceOf,
  createLiveRoutes,
  STALE_AFTER_MS,
  withAskingDevice,
} from "./live-route.js";
import type { DeviceReport } from "./report.js";
import { DeviceConnectionsRepository } from "./repository.js";

const NOW = Date.parse("2026-11-14T09:00:00Z");

function health(live: boolean): DeviceReport["connections"][number] {
  return {
    capability: "apple_health",
    title: "Apple Health",
    prefix: "health",
    personal: true,
    operations: [{ name: "health.stats", access: "read" }],
    permission: "unknown",
    live,
    feeds: "apple_health",
  };
}

describe("the live route", () => {
  let testDb: TestDb;
  let devices: DeviceConnectionsRepository;
  const routes = () => createLiveRoutes(devices, () => NOW);
  const report = (
    id: string,
    connections: DeviceReport["connections"],
    at = NOW,
    originId?: string,
  ) =>
    devices.report(
      { version: 1, device: { id, name: id, platform: "ios", originId }, connections },
      at,
    );

  beforeEach(() => {
    testDb = createTestDb();
    devices = new DeviceConnectionsRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  it("asks only the asking device, and shows its connect card when its Health is off", () => {
    // The guardian's own install has Health off; another install on the same
    // phone reports it working but is not running.
    report("dev-asking", [health(false)]);
    report("dev-other", [health(true)]);
    const pointer = routes().forSource("apple_health", { askingDeviceId: "dev-asking" });
    expect(pointer).toMatchObject({ id: "dev-asking:apple_health", state: "off" });
    expect(connectStep(pointer)).toContain('system:connect_service and kind "apple_health"');
    expect(routes().forOperation("health.stats", { askingDeviceId: "dev-asking" })).toMatchObject({
      connection: { device: { id: "dev-asking" } },
    });
  });

  it("never falls back from an asking device that has no such connection", () => {
    report("dev-asking", []);
    report("dev-other", [health(true)]);
    const pointer = routes().forSource("apple_health", { askingDeviceId: "dev-asking" });
    expect(pointer).toEqual({
      state: "not_connected",
      connect: expect.stringContaining("asking from"),
      kind: "apple_health",
      device: { id: "dev-asking" },
    });
    expect(connectStep(pointer)).toContain('kind "apple_health"');
    expect(routes().forOperation("health.stats", { askingDeviceId: "dev-asking" })).toEqual({
      pointer: expect.objectContaining({ state: "not_connected", kind: "apple_health" }),
    });
  });

  it("without an asking device, never chooses a device whose report is over 7 days old", () => {
    report("dev-stale", [health(true)], NOW - STALE_AFTER_MS - 1);
    expect(routes().forSource("apple_health", {})).toMatchObject({ state: "not_connected" });
    report("dev-fresh", [health(false)], NOW - 60_000);
    expect(routes().forSource("apple_health", {})).toMatchObject({
      device: { id: "dev-fresh" },
      state: "off",
    });
  });

  it("without an asking device, prefers a working one, the install that holds the data first", () => {
    report("dev-a", [health(true)], NOW, "origin-a");
    report("dev-b", [health(true)], NOW - 60_000, "origin-b");
    report("dev-c", [health(false)], NOW, "origin-c");
    expect(routes().forSource("apple_health", {})).toMatchObject({ device: { id: "dev-a" } });
    expect(routes().forSource("apple_health", {}, { originId: "origin-b" })).toMatchObject({
      device: { id: "dev-b" },
    });
    expect(routes().forSource("apple_health", {}, { originId: "origin-c" })).toMatchObject({
      device: { id: "dev-a" },
      state: "working",
    });
  });

  it("marks a stale asking device's connection, which it still asks", () => {
    report("dev-asking", [health(true)], NOW - STALE_AFTER_MS - 1);
    expect(routes().forSource("apple_health", { askingDeviceId: "dev-asking" })).toMatchObject({
      device: { id: "dev-asking" },
      stale: true,
    });
  });

  it("keeps the asking device on the turn's thread context, and ignores a malformed one", () => {
    const context = { channel: "webchat", threadId: "chat-1" };
    expect(askingDeviceOf(withAskingDevice(context, "dev-1"))).toBe("dev-1");
    expect(withAskingDevice(context, "dev 1; drop")).toBe(context);
    expect(withAskingDevice(context, undefined)).toBe(context);
    expect(askingDeviceOf(undefined)).toBeUndefined();
  });

  it("drops a device's rows when it reports none, as at sign-out", () => {
    report("dev-1", [health(true)]);
    report("dev-1", []);
    expect(devices.list()).toEqual([]);
  });
});
