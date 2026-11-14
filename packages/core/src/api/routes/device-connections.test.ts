import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { COOKIE_NAME, createSession } from "../../access/auth.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { DeviceConnectionsRepository } from "../../connections/device/repository.js";
import { deviceConnectionRoutes } from "./device-connections.js";

const GUARDIAN_COOKIE = `${COOKIE_NAME}=${createSession("guardian-seat")}`;
const NOW = Date.parse("2026-11-14T10:20:00Z");

const health = {
  capability: "apple_health",
  title: "Apple Health",
  prefix: "health",
  personal: true,
  operations: [
    { name: "health.stats", access: "read" },
    { name: "health.samples", access: "read" },
  ],
  permission: "unknown",
  live: true,
};
const status = {
  capability: "device",
  title: "Device",
  prefix: "device",
  personal: false,
  operations: [{ name: "device.status", access: "read" }],
  permission: "not_needed",
  live: false,
};

function report(id: string, connections: unknown[]) {
  return { version: 1, device: { id, name: "iPhone", platform: "ios" }, connections };
}

describe("/device-connections routes", () => {
  let testDb: TestDb;
  let app: ReturnType<typeof deviceConnectionRoutes>;
  let now = NOW;

  beforeEach(() => {
    testDb = createTestDb();
    now = NOW;
    app = deviceConnectionRoutes({
      db: testDb.db,
      deviceConnections: new DeviceConnectionsRepository(testDb.db),
      now: () => now,
    });
  });
  afterEach(() => testDb.close());

  const send = (init: RequestInit = {}, cookie: string | null = GUARDIAN_COOKIE) =>
    app.request("/device-connections", {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  const put = (body: unknown) => send({ method: "PUT", body: JSON.stringify(body) });
  const list = async () =>
    ((await (await send()).json()) as { connections: Record<string, unknown>[] }).connections;

  it("takes a device's report and lists it with the state computed", async () => {
    const res = await put(report("dev-1", [health, status]));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await list()).toEqual([
      {
        id: "dev-1:apple_health",
        device: { id: "dev-1", name: "iPhone", platform: "ios" },
        capability: "apple_health",
        title: "Apple Health",
        prefix: "health",
        personal: true,
        operations: health.operations,
        permission: "unknown",
        live: true,
        state: "working",
        lastSeenAt: new Date(NOW).toISOString(),
      },
      expect.objectContaining({ id: "dev-1:device", state: "off", permission: "not_needed" }),
    ]);
  });

  it("replaces only the reporting device's rows, and is the same when sent twice", async () => {
    await put(report("dev-1", [health, status]));
    await put(report("dev-2", [health]));
    now = NOW + 60_000;
    const body = report("dev-1", [{ ...health, permission: "denied" }]);
    await put(body);
    await put(body);
    const rows = await list();
    expect(rows.map((row) => [row.id, row.state, row.lastSeenAt])).toEqual([
      ["dev-1:apple_health", "broken", new Date(NOW + 60_000).toISOString()],
      ["dev-2:apple_health", "working", new Date(NOW).toISOString()],
    ]);
    // An empty list removes every row of that device.
    await put(report("dev-1", []));
    expect((await list()).map((row) => row.id)).toEqual(["dev-2:apple_health"]);
  });

  it("refuses a caller without the guardian's cookie session", async () => {
    expect((await send({}, null)).status).toBe(403);
    const loopback = deviceConnectionRoutes({
      db: testDb.db,
      deviceConnections: new DeviceConnectionsRepository(testDb.db),
      guardianSession: async () => ({ userId: "guardian-seat", via: "loopback" }),
    });
    expect((await loopback.request("/device-connections")).status).toBe(403);
  });

  it("refuses a report that is not JSON, too large, or out of shape", async () => {
    expect(
      (await send({ method: "PUT", body: "{}", headers: { "content-type": "text/plain" } })).status,
    ).toBe(415);
    expect((await send({ method: "PUT", body: "x".repeat(70 * 1024) })).status).toBe(413);
    expect((await send({ method: "PUT", body: "{" })).status).toBe(400);
    for (const bad of [
      report("dev-1", [{ ...health, capability: "Apple Health" }]),
      report("dev-1", [health, health]),
      report("dev-1", [{ ...health, permission: "maybe" }]),
      { ...report("dev-1", []), version: 2 },
    ]) {
      const res = await put(bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("bad_report");
    }
    expect(await list()).toEqual([]);
  });
});
