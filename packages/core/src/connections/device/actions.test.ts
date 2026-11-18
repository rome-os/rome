import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ActionEngine } from "../../apps/actions/engine.js";
import { PERSONAL_DATA_PRIVATE_ONLY } from "../../apps/actions/personal-data.js";
import { ActionRegistryImpl } from "../../apps/actions/registry.js";
import type { DeviceRunResult } from "../../desktops/node-devices.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../../test/db.js";
import { DEVICE_DESCRIBE_ACTION, DEVICE_RUN_ACTION, registerDeviceActions } from "./actions.js";
import { STALE_AFTER_MS, withAskingDevice } from "./live-route.js";
import { type DeviceReport, deviceReportSchema } from "./report.js";
import { DeviceConnectionsRepository } from "./repository.js";

const NOW = Date.parse("2026-11-14T09:00:00Z");

/** The guardian, signed in: a turn their own message started. */
const GUARDIAN = { kind: "guardian" as const, userId: "guardian-1", via: "cookie" as const };

const STATUS = {
  name: "device.status",
  access: "read" as const,
  description: "No arguments. The phone's battery and network now.",
  input: { type: "object", properties: {}, additionalProperties: false },
  examples: [{}],
};

function deviceConnection(live: boolean): DeviceReport["connections"][number] {
  return {
    capability: "device",
    title: "Device",
    prefix: "device",
    personal: false,
    operations: [STATUS],
    permission: "not_needed",
    live,
  };
}

function healthConnection(live: boolean): DeviceReport["connections"][number] {
  return {
    capability: "apple_health",
    title: "Apple Health",
    prefix: "health",
    personal: true,
    operations: [{ name: "health.stats", access: "read", description: "Aggregates." }],
    permission: "unknown",
    live,
    feeds: "apple_health",
  };
}

function report(id: string, name: string, connections: DeviceReport["connections"]): DeviceReport {
  return deviceReportSchema.parse({
    version: 1,
    device: { id, name, platform: "ios" },
    connections,
  });
}

describe("device actions", () => {
  let testDb: TestDb;
  let devices: DeviceConnectionsRepository;
  let engine: ActionEngine;
  let calls: { deviceId: string; action: string; args: Record<string, unknown> }[];
  let answer: DeviceRunResult;

  beforeEach(() => {
    testDb = createTestDb();
    devices = new DeviceConnectionsRepository(testDb.db);
    calls = [];
    answer = { ok: true, result: { batteryLevel: 0.62, batteryState: "unplugged" } };
    const registry = new ActionRegistryImpl();
    registerDeviceActions(registry, {
      connections: devices,
      now: () => NOW,
      run: async (deviceId, action, args) => {
        calls.push({ deviceId, action, args });
        return answer;
      },
    });
    engine = new ActionEngine(registry, createActionEngineRepos(), {
      processRole: "main",
      isFirstPartyAction: () => true,
    });
  });
  afterEach(() => testDb.close());

  it("lists each device's capabilities, operations and state from the last report", async () => {
    devices.report(
      report("dev-1", "iPhone", [healthConnection(false), deviceConnection(true)]),
      NOW,
    );
    const result = await engine.run(DEVICE_DESCRIBE_ACTION, {}, { audience: "private" });
    expect(result).toEqual({
      status: "ok",
      data: {
        devices: [
          {
            id: "dev-1",
            name: "iPhone",
            platform: "ios",
            lastSeenAt: new Date(NOW).toISOString(),
            capabilities: [
              {
                kind: "apple_health",
                title: "Apple Health",
                personal: true,
                state: "off",
                next: expect.stringContaining('connect_account and kind "apple_health"'),
                operations: [{ name: "health.stats", access: "read", description: "Aggregates." }],
              },
              {
                kind: "device",
                title: "Device",
                personal: false,
                state: "working",
                operations: [STATUS],
              },
            ],
          },
        ],
      },
    });
    expect(calls).toEqual([]);
  });

  it("lists a capability the device adds with no core or prompt change", async () => {
    const added = {
      capability: "screen_time",
      title: "Screen Time",
      prefix: "screen",
      personal: true,
      operations: [
        {
          name: "screen.usage",
          access: "read" as const,
          description: "Minutes per app over a window.",
          input: { type: "object", properties: { start: { type: "string" } } },
          examples: [{ start: "2026-11-13" }],
        },
      ],
      permission: "granted" as const,
      live: true,
    };
    devices.report(report("dev-1", "iPhone", [deviceConnection(true), added]), NOW);
    const result = await engine.run(DEVICE_DESCRIBE_ACTION, {}, { audience: "private" });
    expect(result).toMatchObject({
      status: "ok",
      data: { devices: [{ capabilities: [{ kind: "device" }, { kind: "screen_time" }] }] },
    });
    const listed = (result as { data: { devices: { capabilities: unknown[] }[] } }).data.devices[0]
      ?.capabilities[1];
    expect(listed).toMatchObject({ operations: added.operations, state: "working" });
  });

  it("takes an older app's report, whose operations carry only name and access", () => {
    const old = deviceReportSchema.safeParse({
      version: 1,
      device: { id: "dev-1" },
      connections: [
        {
          capability: "device",
          title: "Device",
          prefix: "device",
          personal: false,
          operations: [{ name: "device.status", access: "read" }],
          permission: "not_needed",
          live: true,
        },
      ],
    });
    expect(old.success).toBe(true);
  });

  it("reads device.status in a Concierge turn, through the node client, with no task chat", async () => {
    devices.report(report("dev-1", "iPhone", [deviceConnection(true)]), NOW);
    // A Concierge turn in the main chat carries the chat's audience, here a
    // shared one: Device is not personal, so it still runs.
    for (const audience of ["private", "shared"] as const) {
      const result = await engine.run(
        DEVICE_RUN_ACTION,
        { operation: "device.status" },
        { audience, agentName: "concierge" },
      );
      expect(result).toEqual({
        status: "ok",
        data: {
          device: { id: "dev-1", name: "iPhone" },
          connection: "dev-1:device",
          result: { batteryLevel: 0.62, batteryState: "unplugged" },
        },
      });
    }
    expect(calls).toEqual([
      { deviceId: "dev-1", action: "device.status", args: {} },
      { deviceId: "dev-1", action: "device.status", args: {} },
    ]);
  });

  it("runs a write operation only in a private turn", async () => {
    const calendar: DeviceReport["connections"][number] = {
      capability: "lights",
      title: "Lights",
      prefix: "lights",
      personal: false,
      operations: [{ name: "lights.set", access: "write", description: "Turns a light on." }],
      permission: "not_needed",
      live: true,
    };
    devices.report(report("dev-1", "iPhone", [calendar]), NOW);
    const shared = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "lights.set", args: { on: true } },
      { audience: "shared" },
    );
    expect(shared).toMatchObject({ status: "error" });
    expect((shared as { error: string }).error).toMatch(/^write_private_only:/);
    expect(calls).toEqual([]);
    const own = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "lights.set", args: { on: true } },
      { audience: "private", actor: GUARDIAN },
    );
    expect(own).toMatchObject({ status: "ok" });
    expect(calls).toEqual([{ deviceId: "dev-1", action: "lights.set", args: { on: true } }]);
  });

  it("runs a write only in a turn the guardian's own message started", async () => {
    devices.report(
      report("dev-1", "iPhone", [
        {
          ...deviceConnection(true),
          operations: [{ name: "device.ring", access: "write", description: "Rings it." }],
        },
      ]),
      NOW,
    );
    // A routine or a followed mail runs with no actor; a loopback caller is
    // the guardian's seat, but not the guardian asking.
    for (const actor of [undefined, { ...GUARDIAN, via: "loopback" as const }]) {
      const result = await engine.run(
        DEVICE_RUN_ACTION,
        { operation: "device.ring" },
        { audience: "private", ...(actor ? { actor } : {}) },
      );
      expect((result as { error: string }).error).toMatch(/^write_needs_guardian:/);
    }
    expect(calls).toEqual([]);
    // A read still runs in such a turn.
    devices.report(report("dev-1", "iPhone", [deviceConnection(true)]), NOW);
    expect(
      await engine.run(DEVICE_RUN_ACTION, { operation: "device.status" }, { audience: "private" }),
    ).toMatchObject({ status: "ok" });
  });

  it("says a write did nothing when the device does not answer", async () => {
    devices.report(
      report("dev-1", "iPhone", [
        {
          ...deviceConnection(true),
          operations: [{ name: "device.ring", access: "write", description: "Rings it." }],
        },
      ]),
      NOW,
    );
    answer = { ok: false, code: "target_unavailable", message: "offline" };
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.ring" },
      { audience: "private", actor: GUARDIAN },
    );
    const error = (result as { error: string }).error;
    expect(error).toMatch(/^target_unavailable:/);
    expect(error).toContain("opens the Rome app");
    expect(error).toContain("Nothing was changed.");
  });

  it("refuses a personal capability in a shared turn and calls no device", async () => {
    devices.report(report("dev-1", "iPhone", [healthConnection(true)]), NOW);
    for (const audience of ["shared", undefined] as const) {
      const result = await engine.run(
        DEVICE_RUN_ACTION,
        { operation: "health.stats", args: { type: "stepCount" } },
        { audience },
      );
      expect(result).toEqual({ status: "error", error: PERSONAL_DATA_PRIVATE_ONLY });
    }
    expect(calls).toEqual([]);
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "health.stats", args: { type: "stepCount" } },
      { audience: "private" },
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(calls).toEqual([
      { deviceId: "dev-1", action: "health.stats", args: { type: "stepCount" } },
    ]);
  });

  it("answers live_off with the connect card's step for an off connection, and calls no device", async () => {
    devices.report(report("dev-1", "iPhone", [deviceConnection(false)]), NOW);
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.status" },
      { audience: "private" },
    );
    expect(result).toEqual({
      status: "error",
      error:
        'live_off: Live access to Device on iPhone is off. Offer to turn it on: show the card with connect_account and kind "device" when connect_account lists it, otherwise ask the guardian to turn on Live access in the Rome app on their device.',
    });
    expect(calls).toEqual([]);
  });

  it("answers permission_denied for a broken connection, and calls no device", async () => {
    devices.report(
      report("dev-1", "iPhone", [{ ...healthConnection(true), permission: "denied" }]),
      NOW,
    );
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "health.stats" },
      { audience: "private" },
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/^permission_denied: .*allow it in the device's settings\.$/),
    });
    expect(calls).toEqual([]);
  });

  it("answers not_connected when no device offers the operation", async () => {
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.status" },
      { audience: "private" },
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/^not_connected: .*core:device_describe/),
    });
    expect(calls).toEqual([]);
  });

  it("picks the working device that reported last, unless the Agent names one", async () => {
    devices.report(report("dev-ipad", "iPad", [deviceConnection(true)]), NOW - 60_000);
    devices.report(report("dev-phone", "iPhone", [deviceConnection(true)]), NOW);
    devices.report(report("dev-old", "Old iPhone", [deviceConnection(false)]), NOW + 60_000);
    await engine.run(DEVICE_RUN_ACTION, { operation: "device.status" }, { audience: "private" });
    await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.status", device: "dev-ipad" },
      { audience: "private" },
    );
    expect(calls.map((call) => call.deviceId)).toEqual(["dev-phone", "dev-ipad"]);
  });

  it("asked from a device whose Device is off, answers its connect card and calls no other", async () => {
    devices.report(report("dev-asking", "iPhone", [deviceConnection(false)]), NOW);
    devices.report(report("dev-other", "iPad", [deviceConnection(true)]), NOW);
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.status" },
      {
        audience: "private",
        channelContext: withAskingDevice({ channel: "webchat", threadId: "chat-1" }, "dev-asking"),
      },
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/^live_off: .*connect_account and kind "device"/),
    });
    expect(calls).toEqual([]);
  });

  it("asked from a device that has no such connection, offers the card and calls no other", async () => {
    devices.report(report("dev-asking", "iPhone", []), NOW);
    devices.report(report("dev-other", "iPad", [deviceConnection(true)]), NOW);
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.status" },
      {
        audience: "private",
        channelContext: withAskingDevice({ channel: "webchat", threadId: "chat-1" }, "dev-asking"),
      },
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/^not_connected: .*asking device.*kind "device"/),
    });
    expect(calls).toEqual([]);
  });

  it("never chooses a device that has not reported for 7 days, and lists it as stale", async () => {
    devices.report(
      report("dev-stale", "iPhone", [deviceConnection(true)]),
      NOW - STALE_AFTER_MS - 1,
    );
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.status" },
      { audience: "private" },
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/^not_connected: /),
    });
    expect(calls).toEqual([]);
    expect(await engine.run(DEVICE_DESCRIBE_ACTION, {}, { audience: "private" })).toMatchObject({
      data: { devices: [{ id: "dev-stale", stale: true }] },
    });
  });

  it("names the asking device in the listing, connected or not, and keeps a named device", async () => {
    devices.report(report("dev-other", "iPad", [deviceConnection(true)]), NOW);
    const from = (deviceId: string) => ({
      audience: "private" as const,
      channelContext: withAskingDevice({ channel: "webchat", threadId: "chat-1" }, deviceId),
    });
    // The guardian asks from a device that reports nothing.
    expect(await engine.run(DEVICE_DESCRIBE_ACTION, {}, from("dev-asking"))).toMatchObject({
      data: {
        askingDevice: { id: "dev-asking", connected: false },
        devices: [{ id: "dev-other" }],
      },
    });
    devices.report(report("dev-asking", "iPhone", [deviceConnection(false)]), NOW);
    expect(await engine.run(DEVICE_DESCRIBE_ACTION, {}, from("dev-asking"))).toMatchObject({
      data: { askingDevice: { id: "dev-asking", connected: true } },
    });
    // A turn no device started names none.
    const web = await engine.run(DEVICE_DESCRIBE_ACTION, {}, { audience: "private" });
    expect((web as { data: Record<string, unknown> }).data.askingDevice).toBeUndefined();
    // "My iPad's battery": a device the guardian names is read, whatever device asks.
    await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.status", device: "dev-other" },
      from("dev-asking"),
    );
    expect(calls.map((call) => call.deviceId)).toEqual(["dev-other"]);
  });

  it("answers target_unavailable at once for a device that is offline", async () => {
    devices.report(report("dev-1", "iPhone", [deviceConnection(true)]), NOW);
    answer = { ok: false, code: "target_unavailable", message: "Device is not connected." };
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.status" },
      { audience: "private" },
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/^target_unavailable: iPhone did not answer/),
    });
    expect(calls).toHaveLength(1);
  });

  it("passes on the device's own error", async () => {
    devices.report(report("dev-1", "iPhone", [deviceConnection(true)]), NOW);
    answer = { ok: false, code: "invalid_args", message: "device.status takes no arguments." };
    const result = await engine.run(
      DEVICE_RUN_ACTION,
      { operation: "device.status", args: { x: 1 } },
      { audience: "private" },
    );
    expect(result).toEqual({
      status: "error",
      error: "invalid_args: device.status takes no arguments.",
    });
  });
});
