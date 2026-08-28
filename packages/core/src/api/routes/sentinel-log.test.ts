import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { Hono } from "hono";
import { sentinelLogRoutes } from "./sentinel-log.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../test/seeds.js";

describe("Sentinel-log API", () => {
  let testDb: TestDb;
  let app: Hono;
  let baseline: BaselineIds;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    const deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", sentinelLogRoutes(deps));
  });

  afterEach(() => testDb.close());

  it("lists all entries (unfiltered)", async () => {
    const res = await app.request("/sentinel-log");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; messageId: string }[];
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        baseline.sentinelLog.repliedId,
        baseline.sentinelLog.ignoredKnownId,
        baseline.sentinelLog.unknownSenderId,
      ]),
    );
  });

  it("orders unfiltered list by created_at desc (newest first)", async () => {
    const res = await app.request("/sentinel-log");
    const rows = (await res.json()) as { id: string; createdAt: string | number }[];
    const tsInOrder = rows.map((r) => new Date(r.createdAt).getTime());
    for (let i = 1; i < tsInOrder.length; i++) {
      expect(tsInOrder[i - 1]).toBeGreaterThanOrEqual(tsInOrder[i]);
    }
  });

  it("filters by reviewed=false", async () => {
    const before = (await (await app.request("/sentinel-log?reviewed=false")).json()) as {
      id: string;
    }[];
    expect(before.map((r) => r.id)).toContain(baseline.sentinelLog.ignoredKnownId);

    const review = await app.request(
      `/sentinel-log/${baseline.sentinelLog.ignoredKnownId}/review`,
      { method: "POST" },
    );
    expect(review.status).toBe(200);

    const after = (await (await app.request("/sentinel-log?reviewed=false")).json()) as {
      id: string;
    }[];
    expect(after.map((r) => r.id)).not.toContain(baseline.sentinelLog.ignoredKnownId);
    expect(after.map((r) => r.id)).toContain(baseline.sentinelLog.repliedId);
  });

  it("returns 404 when reviewing an unknown id", async () => {
    const res = await app.request("/sentinel-log/does-not-exist/review", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
