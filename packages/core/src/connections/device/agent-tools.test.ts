import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { DevicesStatus } from "@rome/api-types/devices";
import {
  approvalOf,
  callTool,
  GUARDIAN_TURN,
  whoMayAskSuite,
} from "../../apps/actions/agent-tool-contract.js";
import type { DeviceManageResult, DeviceRunResult } from "../../desktops/node-devices.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import {
  type DeviceToolDeps,
  readDevices,
  removeDevice,
  renameDevice,
  runOnDeviceTool,
} from "./agent-tools.js";
import { withAskingDevice } from "./live-route.js";
import { type DeviceReport, deviceReportSchema } from "./report.js";
import { DeviceConnectionsRepository } from "./repository.js";

whoMayAskSuite(readDevices, {});
whoMayAskSuite(runOnDeviceTool, { operation: "device.status" });
whoMayAskSuite(renameDevice, { deviceId: "dev-phone", name: "Work iPhone" });
whoMayAskSuite(removeDevice, { deviceId: "dev-phone" });

const NOW = Date.parse("2026-11-24T09:00:00Z");

const STATUS_OPERATION = {
  name: "device.status",
  access: "read" as const,
  description: "No arguments. The phone's battery and network now.",
};

function phoneReport(connections: DeviceReport["connections"]): DeviceReport {
  return deviceReportSchema.parse({
    version: 1,
    device: { id: "dev-phone", name: "iPhone", platform: "ios" },
    connections,
  });
}

const deviceCapability: DeviceReport["connections"][number] = {
  capability: "device",
  title: "Device",
  prefix: "device",
  personal: false,
  operations: [
    STATUS_OPERATION,
    { name: "device.ring", access: "write", description: "Rings it." },
  ],
  permission: "not_needed",
  live: true,
};

const healthCapability: DeviceReport["connections"][number] = {
  capability: "apple_health",
  title: "Apple Health",
  prefix: "health",
  personal: true,
  operations: [{ name: "health.stats", access: "read", description: "Aggregates." }],
  permission: "unknown",
  live: true,
  feeds: "apple_health",
};

/** The status the Devices page reads: the phone and a computer, both online. */
const ONLINE: DevicesStatus = {
  connection: "online",
  checkedAt: new Date(NOW).toISOString(),
  devices: [
    { id: "dev-phone", name: "Phone", platform: "ios", status: "connected" },
    { id: "dev-mac", name: "MacBook", platform: "darwin", status: "not_connected" },
  ],
};

describe("the Devices page's tools", () => {
  let testDb: TestDb;
  let connections: DeviceConnectionsRepository;
  let status: DevicesStatus;
  let answer: DeviceRunResult;
  let manage: DeviceManageResult;
  let runs: Array<{ deviceId: string; action: string; args: Record<string, unknown> }>;
  let deps: DeviceToolDeps;

  beforeEach(() => {
    testDb = createTestDb();
    connections = new DeviceConnectionsRepository(testDb.db);
    connections.report(phoneReport([deviceCapability, healthCapability]), NOW);
    status = ONLINE;
    answer = { ok: true, result: { batteryLevel: 0.62 } };
    manage = { ok: true };
    runs = [];
    deps = {
      devices: {
        getStatus: async () => status,
        listDevices: async () => ({
          devices: status.devices.map(({ id, name, platform }) => ({ id, name, platform })),
        }),
        renameDevice: rs.fn(async () => manage),
        removeDevice: rs.fn(async () => manage),
      },
      connections,
      run: async (deviceId, action, args) => {
        runs.push({ deviceId, action, args });
        return answer;
      },
      now: () => NOW,
    };
  });
  afterEach(() => testDb.close());

  describe("reading the devices", () => {
    it("lists each device the page shows, whether it is online, and what it lets Rome reach", async () => {
      const result = await callTool(readDevices, deps, {});

      expect(result).toEqual({
        status: "ok",
        data: {
          checkedAt: ONLINE.checkedAt,
          devices: [
            {
              deviceId: "dev-phone",
              name: "Phone",
              platform: "ios",
              status: "connected",
              capabilities: [
                expect.objectContaining({ kind: "apple_health", personal: true }),
                expect.objectContaining({
                  kind: "device",
                  state: "working",
                  personal: false,
                  operations: expect.arrayContaining([STATUS_OPERATION]),
                }),
              ],
            },
            {
              deviceId: "dev-mac",
              name: "MacBook",
              platform: "darwin",
              status: "not_connected",
              capabilities: [],
            },
          ],
        },
      });
      expect(runs).toEqual([]);
    });

    it("marks the device the guardian is asking from", async () => {
      const turn = {
        ...GUARDIAN_TURN,
        channelContext: withAskingDevice(GUARDIAN_TURN.channelContext!, "dev-phone"),
      };

      const result = await callTool(readDevices, deps, {}, turn);

      const data = (result as { data: { askingDevice: unknown; devices: unknown[] } }).data;
      expect(data.askingDevice).toEqual({ id: "dev-phone", connected: true });
      expect(data.devices[0]).toMatchObject({ deviceId: "dev-phone", asking: true });
    });

    it("says why no device can be reached when the device service is down", async () => {
      status = { connection: "not_running", checkedAt: ONLINE.checkedAt, devices: [] };

      const result = await callTool(readDevices, deps, {});

      const data = (result as { data: Record<string, unknown> }).data;
      expect(data.deviceService).toEqual({
        state: "not_running",
        note: expect.stringContaining("Settings › Devices"),
      });
      // The phone still reported what it offers, so it is listed.
      expect(data.devices).toEqual([
        expect.objectContaining({ deviceId: "dev-phone", status: "unknown" }),
      ]);
    });
  });

  describe("reading the devices' status fresh", () => {
    let reads: number;
    let answers: Array<() => Promise<DevicesStatus>>;

    beforeEach(() => {
      rs.useFakeTimers();
      rs.setSystemTime(NOW);
      deps.now = undefined;
      // The device service answers its last snapshot, then whatever the test
      // queues, then `status`.
      reads = 0;
      answers = [];
      deps.devices.getStatus = async () => {
        reads += 1;
        return await (answers.shift()?.() ?? status);
      };
    });
    afterEach(() => {
      rs.useRealTimers();
    });

    const stale = { ...ONLINE, checkedAt: new Date(NOW - 60_000).toISOString() };
    /** Reads the devices while the clock runs for `ms`. */
    const readFor = async (ms: number) => {
      const read = callTool(readDevices, deps, {});
      await rs.advanceTimersByTimeAsync(ms);
      return (await read) as { data: { checkedAt: string; devices: unknown[] } };
    };

    it("waits for the check a stale snapshot starts, as the page's next poll would", async () => {
      answers = [
        async () => ({
          ...stale,
          devices: [{ id: "dev-phone", name: "Phone", platform: "ios", status: "connected" }],
        }),
      ];
      status = {
        ...ONLINE,
        checkedAt: new Date(NOW + 400).toISOString(),
        devices: [{ id: "dev-phone", name: "Phone", platform: "ios", status: "not_connected" }],
      };

      const { data } = await readFor(1_000);

      expect(data.devices[0]).toMatchObject({ deviceId: "dev-phone", status: "not_connected" });
      expect(data.checkedAt).toBe(status.checkedAt);
    });

    it("answers the last snapshot with its age when no check comes in time, reading it a few times", async () => {
      status = stale;

      const { data } = await readFor(20_000);

      expect(data.checkedAt).toBe(stale.checkedAt);
      expect(Date.now() - NOW).toBeLessThanOrEqual(20_000);
      expect(reads).toBeLessThanOrEqual(10);
    });

    it("answers the last snapshot at the deadline when the service holds a read", async () => {
      answers = [async () => stale, () => new Promise<DevicesStatus>(() => {})];

      const { data } = await readFor(20_000);

      expect(data.checkedAt).toBe(stale.checkedAt);
      expect(reads).toBe(2);
    });

    it("says it could not read the devices in time when the first read outlasts the deadline", async () => {
      // A cold service reads Rome Cloud's list before it checks any device.
      answers = [
        () => new Promise<DevicesStatus>((resolve) => setTimeout(() => resolve(status), 24_000)),
      ];
      let settled = false;
      const read = callTool(readDevices, deps, {}).finally(() => {
        settled = true;
      });

      await rs.advanceTimersByTimeAsync(20_000);

      expect(settled).toBe(true);
      expect(await read).toEqual({
        status: "error",
        error: expect.stringMatching(/^devices_unavailable:/),
      });
      expect(reads).toBe(1);
    });
  });

  describe("running on a device", () => {
    it("runs the operation with its arguments on the device that offers it", async () => {
      const result = await callTool(runOnDeviceTool, deps, {
        operation: "device.status",
        arguments: { detail: true },
      });

      expect(result).toEqual({
        status: "ok",
        data: {
          device: { id: "dev-phone", name: "iPhone" },
          connection: expect.any(String),
          result: { batteryLevel: 0.62 },
        },
      });
      expect(runs).toEqual([
        { deviceId: "dev-phone", action: "device.status", args: { detail: true } },
      ]);
    });

    it("reads a personal capability in a shared chat", async () => {
      const result = await callTool(
        runOnDeviceTool,
        deps,
        { operation: "health.stats" },
        { ...GUARDIAN_TURN, audience: "shared" },
      );

      expect(result).toMatchObject({ status: "ok" });
      expect(runs).toEqual([{ deviceId: "dev-phone", action: "health.stats", args: {} }]);
    });

    it("reads in a turn no one started, such as a routine's, but changes nothing in one", async () => {
      const routineTurn = {
        audience: "private" as const,
        channelContext: GUARDIAN_TURN.channelContext,
      };

      const read = await callTool(
        runOnDeviceTool,
        deps,
        { operation: "device.status" },
        routineTurn,
      );
      const ring = await callTool(runOnDeviceTool, deps, { operation: "device.ring" }, routineTurn);

      expect(read).toMatchObject({ status: "ok" });
      expect(ring).toEqual({
        status: "error",
        error: expect.stringMatching(/^write_needs_guardian:/),
      });
      expect(runs.map((r) => r.action)).toEqual(["device.status"]);
    });

    it("says what to do when no device offers the operation", async () => {
      const result = await callTool(runOnDeviceTool, deps, { operation: "lights.set" });

      expect(result).toEqual({ status: "error", error: expect.stringMatching(/^not_connected:/) });
      expect(runs).toEqual([]);
    });
  });

  describe("renaming a device", () => {
    it("renames it through the page's service", async () => {
      const result = await callTool(renameDevice, deps, {
        deviceId: "dev-phone",
        name: "Work iPhone",
      });

      expect(result).toEqual({
        status: "ok",
        data: { deviceId: "dev-phone", name: "Work iPhone", renamed: true },
      });
      expect(deps.devices.renameDevice).toHaveBeenCalledWith("dev-phone", "Work iPhone");
    });

    it("says what fits when Rome Cloud turns the name down", async () => {
      manage = { ok: false, code: "invalid_device_name" };

      const result = await callTool(renameDevice, deps, { deviceId: "dev-phone", name: "" });

      expect(result).toEqual({
        status: "error",
        error: expect.stringContaining("1 to 80 characters"),
      });
    });
  });

  it.each([
    ["renaming", renameDevice, { deviceId: "dev-phone", name: "Work iPhone" }],
    ["removing", removeDevice, { deviceId: "dev-phone" }],
  ] as const)("says the outcome is unknown when Rome Cloud does not confirm %s", async (_, tool, args) => {
    manage = { ok: false, code: "unavailable" };

    const result = await callTool(tool, deps, args);

    const error = (result as { error: string }).error;
    expect(error).toMatch(/^outcome_unknown:/);
    expect(error).toContain("may or may not have happened");
    expect(error).not.toContain("nothing changed");
  });

  describe("removing a device", () => {
    it("asks the guardian to approve, naming the device", async () => {
      const card = await approvalOf(removeDevice, deps, { deviceId: "dev-phone" });

      expect(card).toEqual({
        kind: "generic",
        title: "Remove Phone",
        summary: expect.stringContaining("can't use Phone anymore"),
      });
    });

    it("removes it through the page's service", async () => {
      const result = await callTool(removeDevice, deps, { deviceId: "dev-phone" });

      expect(result).toEqual({ status: "ok", data: { deviceId: "dev-phone", removed: true } });
      expect(deps.devices.removeDevice).toHaveBeenCalledWith("dev-phone");
    });

    it("points to read_devices for a device the account does not have", async () => {
      manage = { ok: false, code: "device_not_found" };

      const result = await callTool(removeDevice, deps, { deviceId: "dev-gone" });

      expect(result).toEqual({
        status: "error",
        error: expect.stringContaining("system:read_devices"),
      });
    });
  });
});
