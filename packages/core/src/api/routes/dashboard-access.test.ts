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
});
