import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { Hono } from "hono";
import { dashboardAccessRoutes } from "./dashboard-access.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "../../lib/dashboard-access-config.js";
import { DashboardAccessState } from "../../lib/dashboard-access-state.js";
import { buildTestDeps, createTestDb, type TestDb } from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";

describe("Dashboard-access API", () => {
  let testDb: TestDb;
  let app: Hono;
  let deps: ApiDeps;
  let dashboardAccessState: DashboardAccessState;

  beforeEach(async () => {
    testDb = createTestDb();
    dashboardAccessState = new DashboardAccessState();
    deps = { ...(await buildTestDeps(testDb.db)), dashboardAccessState };
    app = new Hono().route("/", dashboardAccessRoutes(deps));
  });

  afterEach(() => {
    testDb.close();
  });

  it("returns the default config when no row is persisted", async () => {
    const res = await app.request("/dashboard-access");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cloudEmailAccess: [] });
  });

  it("returns the normalized config when a row exists", async () => {
    await deps.settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, {
      cloudEmailAccess: ["Ada@Example.com", "bad email", "ada@example.com"],
    });

    const res = await app.request("/dashboard-access");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cloudEmailAccess: ["ada@example.com"] });
  });

  it("persists the normalized config and refreshes the auth-edge snapshot", async () => {
    const res = await app.request("/dashboard-access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cloudEmailAccess: ["Ada@Example.com", "bad email", "lin@example.com"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const getRes = await app.request("/dashboard-access");
    expect(await getRes.json()).toEqual({
      cloudEmailAccess: ["ada@example.com", "lin@example.com"],
    });
    expect([...dashboardAccessState.cloudEmails()].sort()).toEqual([
      "ada@example.com",
      "lin@example.com",
    ]);
  });

  it("bumps the stored revision on every save and hands each list to the Rome Cloud sync", async () => {
    const pushed: Array<{ emails: readonly string[]; revision: number }> = [];
    deps.visitorAllowListSync.push = (list) => void pushed.push(list);
    const save = (emails: string[]) =>
      app.request("/dashboard-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cloudEmailAccess: emails }),
      });

    await Promise.all([save(["Ada@Example.com"]), save(["lin@example.com"])]);
    await save([]);

    expect(pushed.map((list) => list.revision)).toEqual([1, 2, 3]);
    expect(pushed[2]).toEqual({ emails: [], revision: 3 });
    expect(await deps.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY)).toEqual({
      cloudEmailAccess: [],
      revision: 3,
      signedIn: [],
    });
    const getRes = await app.request("/dashboard-access");
    expect(await getRes.json()).toEqual({ cloudEmailAccess: [] });
  });

  it("refuses a list past the limits and keeps the saved one", async () => {
    await deps.dashboardAccessStore.save({ cloudEmailAccess: ["ada@example.com"] });
    const pushed: unknown[] = [];
    deps.visitorAllowListSync.push = (list) => void pushed.push(list);
    const save = (emails: string[]) =>
      app.request("/dashboard-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cloudEmailAccess: emails }),
      });

    const many = Array.from({ length: 501 }, (_, i) => `user${i}@example.com`);
    const tooMany = await save(many);
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: "too_many_emails", limit: 500 });

    const long = `${"a".repeat(64)}@${"b".repeat(252)}.com`;
    expect(long.length).toBe(321);
    const tooLong = await save([long]);
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "email_too_long", limit: 320 });

    // 500 distinct addresses, plus the same ones in another case, fit.
    const atLimit = await save([...many.slice(0, 500), "USER0@example.com"]);
    expect(atLimit.status).toBe(200);
    expect(pushed).toHaveLength(1);
    expect((await deps.dashboardAccessStore.read()).emails).toHaveLength(500);
  });
});
