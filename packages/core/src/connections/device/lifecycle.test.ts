import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { DeviceManageResult } from "../../desktops/node-devices.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { withDeviceLifecycle } from "./lifecycle.js";
import type { DeviceReport } from "./report.js";
import { DeviceConnectionsRepository } from "./repository.js";

const NOW = Date.parse("2026-11-14T09:00:00Z");

const status: DeviceReport["connections"][number] = {
  capability: "device",
  title: "Device",
  prefix: "device",
  personal: false,
  operations: [{ name: "device.status", access: "read" }],
  permission: "not_needed",
  live: true,
};

describe("the device lifecycle", () => {
  let testDb: TestDb;
  let devices: DeviceConnectionsRepository;
  let turnedOff: string[];
  let removal: DeviceManageResult;

  const report = (id: string, originId?: string) =>
    devices.report(
      { version: 1, device: { id, platform: "ios", originId }, connections: [status] },
      NOW,
    );
  const service = () =>
    withDeviceLifecycle(
      {
        removeDevice: async (_deviceId: string) => removal,
      },
      { connections: () => devices, turnOriginOff: (origin) => turnedOff.push(origin) },
    );
  const ids = () => devices.list().map((c) => c.device.id);

  beforeEach(() => {
    testDb = createTestDb();
    devices = new DeviceConnectionsRepository(testDb.db);
    turnedOff = [];
    removal = { ok: true };
  });
  afterEach(() => testDb.close());

  it("deletes a removed device's rows and turns its install's origin off", async () => {
    report("dev-1", "origin-1");
    report("dev-2", "origin-2");
    await service().removeDevice("dev-1");
    expect(ids()).toEqual(["dev-2"]);
    expect(turnedOff).toEqual(["origin-1"]);
  });

  it("keeps the origin on while another device id of the same install reports it", async () => {
    // A sign-in again on the same install: a new device id, the same origin.
    report("dev-old", "origin-1");
    report("dev-new", "origin-1");
    await service().removeDevice("dev-old");
    expect(ids()).toEqual(["dev-new"]);
    expect(turnedOff).toEqual([]);
  });

  it("changes nothing when the removal fails", async () => {
    report("dev-1", "origin-1");
    removal = { ok: false, code: "unavailable" };
    await service().removeDevice("dev-1");
    expect(ids()).toEqual(["dev-1"]);
    expect(turnedOff).toEqual([]);
  });

  it("keeps a failed removal's rows, so the retry that succeeds turns the origin off", async () => {
    report("dev-1", "origin-1");
    removal = { ok: false, code: "unavailable" };
    await service().removeDevice("dev-1");
    expect(ids()).toEqual(["dev-1"]);
    removal = { ok: true };
    await service().removeDevice("dev-1");
    expect(ids()).toEqual([]);
    expect(turnedOff).toEqual(["origin-1"]);
  });
});
