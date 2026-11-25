import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import { registerPersonalDataActions } from "./actions.js";
import { PersonalDataRepository } from "./repository.js";
import { DeviceConnectionsRepository } from "../connections/device/repository.js";
import { createLiveRoutes, withAskingDevice } from "../connections/device/live-route.js";
import { withDeviceLifecycle } from "../connections/device/lifecycle.js";
import { APPLE_HEALTH } from "./sources/apple-health.js";
import { PERSONAL_DATA_SOURCES } from "./sources/index.js";
import { batch, DAY, HOUR, NOV_10, ORIGIN, stepDay, TZ } from "./__fixtures__/apple-health.js";

describe("personal-data actions", () => {
  let testDb: TestDb;
  let engine: ActionEngine;
  let devices: DeviceConnectionsRepository;
  let repo: PersonalDataRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES);
    repo.ingest(
      APPLE_HEALTH,
      {
        ...batch("seed", {
          upserts: [stepDay(NOV_10, 8000), stepDay(NOV_10 + DAY, 6000)],
          types: [{ type: "stepCount", syncedThrough: new Date(NOV_10 + 2 * DAY).toISOString() }],
        }),
        connectionId: "dev-1:apple_health",
      },
      NOV_10 + 2 * DAY,
    );
    devices = new DeviceConnectionsRepository(testDb.db);
    const registry = new ActionRegistryImpl();
    registerPersonalDataActions(registry, {
      personalData: repo,
      guardianTimeZone: async () => TZ,
      connections: createLiveRoutes(devices, () => NOV_10 + 2 * DAY + 9 * HOUR),
      now: () => NOV_10 + 2 * DAY + 9 * HOUR,
    });
    engine = new ActionEngine(registry, createActionEngineRepos(), {
      processRole: "main",
      isFirstPartyAction: () => true,
    });
  });
  afterEach(() => testDb.close());

  it("lists the catalog in a private turn", async () => {
    const result = await engine.run("core:personal_data_catalog", {}, { audience: "private" });
    expect(result).toMatchObject({
      status: "ok",
      data: { sources: [{ source: "apple_health", origin: { name: "iPhone" } }] },
    });
  });

  it("answers a query in a private turn, in the guardian's zone by default", async () => {
    const result = await engine.run(
      "core:personal_data_query",
      { source: "apple_health", type: "stepCount", start: "2026-11-10", end: "2026-11-11" },
      { audience: "private" },
    );
    expect(result).toMatchObject({
      status: "ok",
      data: { timeZoneIdentifier: TZ, results: [{ type: "stepCount", value: 14000 }] },
    });
  });

  it("answers a routine's fire, which adds the payload that fired it", async () => {
    const result = await engine.run(
      "core:personal_data_query",
      {
        source: "apple_health",
        type: "stepCount",
        start: "2026-11-10",
        end: "2026-11-11",
        __triggerPayload: { firedAt: "2026-11-12T09:00:00Z" },
      },
      { audience: "private" },
    );
    expect(result).toMatchObject({ status: "ok", data: { results: [{ value: 14000 }] } });
  });

  it("points at the install whose origin holds the data, where the store does not cover the window", async () => {
    const today = { source: "apple_health", type: "stepCount", start: "2026-11-12" };
    const before = await engine.run("core:personal_data_query", today, { audience: "private" });
    expect(before).toMatchObject({
      status: "ok",
      data: { connection: { state: "not_connected", next: expect.stringContaining("Rome app") } },
    });
    devices.report(
      {
        version: 1,
        device: { id: "dev-1", name: "iPhone", platform: "ios", originId: ORIGIN },
        connections: [
          {
            capability: "apple_health",
            title: "Apple Health",
            prefix: "health",
            personal: true,
            operations: [{ name: "health.stats", access: "read" }],
            permission: "unknown",
            live: true,
            feeds: "apple_health",
          },
        ],
      },
      NOV_10 + 2 * DAY + 8 * HOUR,
    );
    const after = await engine.run("core:personal_data_query", today, { audience: "private" });
    expect(after).toMatchObject({
      status: "ok",
      data: {
        freshness: { stepCount: { coversWindow: false, missingFrom: expect.any(String) } },
        connection: {
          id: "dev-1:apple_health",
          title: "Apple Health",
          device: { id: "dev-1", name: "iPhone" },
          state: "working",
          lastSeenAt: new Date(NOV_10 + 2 * DAY + 8 * HOUR).toISOString(),
        },
      },
    });
    // A window the store covers needs no pointer.
    const covered = await engine.run(
      "core:personal_data_query",
      { source: "apple_health", type: "stepCount", start: "2026-11-10", end: "2026-11-11" },
      { audience: "private" },
    );
    expect((covered as { data: Record<string, unknown> }).data.connection).toBeUndefined();
    const catalog = await engine.run("core:personal_data_catalog", {}, { audience: "private" });
    expect(catalog).toMatchObject({
      data: { sources: [{ connection: { id: "dev-1:apple_health", state: "working" } }] },
    });
  });

  it("finds the connection by the source its device feeds when no sync has named one", async () => {
    // A fresh store: the phone connected Health, but no batch arrived yet.
    testDb.close();
    testDb = createTestDb();
    devices = new DeviceConnectionsRepository(testDb.db);
    const registry = new ActionRegistryImpl();
    registerPersonalDataActions(registry, {
      personalData: new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES),
      guardianTimeZone: async () => TZ,
      connections: createLiveRoutes(devices, () => NOV_10 + 9 * HOUR),
      now: () => NOV_10 + 9 * HOUR,
    });
    engine = new ActionEngine(registry, createActionEngineRepos(), {
      processRole: "main",
      isFirstPartyAction: () => true,
    });
    const reportHealth = (permission: "unknown" | "denied", live: boolean) =>
      devices.report(
        {
          version: 1,
          device: { id: "dev-1", name: "iPhone", platform: "ios" },
          connections: [
            {
              capability: "apple_health",
              title: "Apple Health",
              prefix: "health",
              personal: true,
              operations: [{ name: "health.stats", access: "read" }],
              permission,
              live,
              feeds: "apple_health",
            },
          ],
        },
        NOV_10 + 8 * HOUR,
      );
    const query = () =>
      engine.run(
        "core:personal_data_query",
        { source: "apple_health", type: "stepCount" },
        { audience: "private" },
      );
    reportHealth("unknown", true);
    expect(await query()).toMatchObject({
      data: { connection: { id: "dev-1:apple_health", state: "working" } },
    });
    expect(
      await engine.run("core:personal_data_catalog", {}, { audience: "private" }),
    ).toMatchObject({
      data: {
        sources: [{ source: "apple_health", types: [], connection: { id: "dev-1:apple_health" } }],
      },
    });
    // A working connection is read live now, never by a check scheduled for later.
    const working = (await query()) as { data: { connection: { next?: string } } };
    expect(working.data.connection.next).toContain('system:run_on_device and deviceId "dev-1"');
    expect(working.data.connection.next).toContain("Do not schedule a later check");
    reportHealth("unknown", false);
    const off = (await query()) as { data: { connection: { next?: string } } };
    expect(off).toMatchObject({ data: { connection: { state: "off", kind: "apple_health" } } });
    expect(off.data.connection.next).toContain('connect_account and kind "apple_health"');
    reportHealth("denied", true);
    const broken = (await query()) as { data: { connection: { next?: string } } };
    expect(broken).toMatchObject({ data: { connection: { state: "broken" } } });
    expect(broken.data.connection.next).toContain("device's settings");
    // The catalog lists the pointer, and leaves the step to the query that found the gap.
    const catalog = (await engine.run(
      "core:personal_data_catalog",
      {},
      { audience: "private" },
    )) as {
      data: { sources: { connection: Record<string, unknown> }[] };
    };
    expect(catalog.data.sources[0].connection.next).toBeUndefined();
  });

  it("returns a query it cannot answer as an error the Agent reads", async () => {
    const result = await engine.run(
      "core:personal_data_query",
      { source: "apple_health", type: "mood" },
      { audience: "private" },
    );
    expect(result).toMatchObject({ status: "error" });
  });

  it.each([
    { audience: "shared" as const },
    {},
  ])("refuses both actions outside a private turn (%o), before they run", async (context) => {
    for (const name of ["core:personal_data_catalog", "core:personal_data_query"]) {
      const result = await engine.run(name, { source: "apple_health", type: "stepCount" }, context);
      expect(result).toEqual({
        status: "error",
        error: expect.stringMatching(/^personal_data_private_only: /),
      });
    }
  });

  const healthOn = (device: string, live: boolean, originId: string) =>
    devices.report(
      {
        version: 1,
        device: { id: device, name: "iPhone", platform: "ios", originId },
        connections: [
          {
            capability: "apple_health",
            title: "Apple Health",
            prefix: "health",
            personal: true,
            operations: [{ name: "health.stats", access: "read" }],
            permission: "unknown",
            live,
            feeds: "apple_health",
          },
        ],
      },
      NOV_10 + 2 * DAY + 8 * HOUR,
    );
  const today = { source: "apple_health", type: "stepCount", start: "2026-11-12" };

  it("asked from a device whose Health is off, offers its card and never points at another", async () => {
    healthOn("dev-asking", false, "origin-dev");
    healthOn("dev-other", true, ORIGIN);
    const result = await engine.run("core:personal_data_query", today, {
      audience: "private",
      channelContext: withAskingDevice({ channel: "webchat", threadId: "chat-1" }, "dev-asking"),
    });
    expect(result).toMatchObject({
      status: "ok",
      data: {
        connection: {
          device: { id: "dev-asking" },
          state: "off",
          next: expect.stringContaining('connect_account and kind "apple_health"'),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("dev-other");
  });

  it("lists a source no device has synced when only another device reads it, with its card's kind", async () => {
    testDb.close();
    testDb = createTestDb();
    devices = new DeviceConnectionsRepository(testDb.db);
    const registry = new ActionRegistryImpl();
    registerPersonalDataActions(registry, {
      personalData: new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES),
      guardianTimeZone: async () => TZ,
      connections: createLiveRoutes(devices, () => NOV_10 + 2 * DAY + 9 * HOUR),
    });
    engine = new ActionEngine(registry, createActionEngineRepos(), {
      processRole: "main",
      isFirstPartyAction: () => true,
    });
    healthOn("dev-other", true, "origin-other");
    const catalog = await engine.run(
      "core:personal_data_catalog",
      {},
      {
        audience: "private",
        channelContext: withAskingDevice({ channel: "webchat", threadId: "chat-1" }, "dev-asking"),
      },
    );
    expect(catalog).toMatchObject({
      status: "ok",
      data: {
        sources: [
          {
            source: "apple_health",
            types: [],
            connection: {
              state: "not_connected",
              kind: "apple_health",
              device: { id: "dev-asking" },
            },
          },
        ],
      },
    });
  });

  it("reads none of a removed device's data, and points at no connection of it", async () => {
    healthOn("dev-1", true, ORIGIN);
    const lifecycle = withDeviceLifecycle(
      {
        removeDevice: async (_deviceId: string) => ({ ok: true as const }),
        listDevices: async () => ({ devices: [] }),
      },
      {
        connections: () => devices,
        turnOriginOff: (origin) => repo.setState("apple_health", origin, "off"),
      },
    );
    await lifecycle.removeDevice("dev-1");
    expect(devices.list()).toEqual([]);
    const result = await engine.run(
      "core:personal_data_query",
      { source: "apple_health", type: "stepCount", start: "2026-11-10", end: "2026-11-11" },
      { audience: "private" },
    );
    expect(result).toMatchObject({
      status: "ok",
      data: { connection: { state: "not_connected" } },
    });
    expect(
      (result as { data: { results: { value?: number }[] } }).data.results[0]?.value,
    ).toBeUndefined();
  });
});

describe("personal data and the device table", () => {
  it("asks the connection layer, and never imports the device-connections repository", () => {
    const folder = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(folder, { recursive: true, encoding: "utf8" }).filter(
      (file) =>
        file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("__fixtures__"),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(join(folder, file), "utf8");
      expect({ file, imports: /connections\/device\/repository/.test(text) }).toEqual({
        file,
        imports: false,
      });
    }
  });
});
