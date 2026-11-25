import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { dashboardAccessRoutes } from "./dashboard-access.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "../../access/dashboard-access-config.js";
import {
  guardianSeatCreated,
  inviteMember,
  listMembers,
  memberContext,
} from "../../access/application/members.js";
import { DashboardAccessState } from "../../access/dashboard-access-state.js";
import { createCloudGuardian } from "../../access/guardian-auth-state.js";
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

  it("returns the members' emails, normalized", async () => {
    await inviteMember(memberContext(testDb.db), "Ada@Example.com");

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
      visitorAccounts: {},
    });
    const getRes = await app.request("/dashboard-access");
    expect(await getRes.json()).toEqual({ cloudEmailAccess: [] });
  });

  it("saves the members, then hands the snapshot and Rome Cloud the same emails, the guardian's left out", async () => {
    const ctx = memberContext(testDb.db);
    await createCloudGuardian(testDb.db, "acct-owner", "owner@example.com");
    await guardianSeatCreated(ctx, {
      accounts: [{ platform: "rome-cloud-email", accountId: "owner@example.com" }],
    });
    const pushed: Array<{ emails: readonly string[]; revision: number }> = [];
    deps.visitorAllowListSync.push = (list) => void pushed.push(list);

    const res = await app.request("/dashboard-access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloudEmailAccess: ["lin@example.com", "Owner@Example.com"] }),
    });

    expect(res.status).toBe(200);
    expect(
      (await listMembers(ctx)).map((m) => ({
        role: m.role,
        emails: m.accounts.map((a) => a.accountId),
      })),
    ).toEqual([
      { role: "guardian", emails: ["owner@example.com"] },
      { role: "member", emails: ["lin@example.com"] },
    ]);
    // A sign-in with the guardian's email is the guardian's person, so the
    // snapshot lets it in, but the list stays the members'.
    expect([...dashboardAccessState.cloudEmails()]).toEqual(["lin@example.com"]);
    expect(dashboardAccessState.isCloudEmailAllowed("owner@example.com")).toBe(true);
    expect(pushed).toEqual([{ emails: ["lin@example.com"], revision: 1 }]);
    const getRes = await app.request("/dashboard-access");
    expect(await getRes.json()).toEqual({ cloudEmailAccess: ["lin@example.com"] });
  });

  it("fails the save when the members cannot be written, and tells neither the snapshot nor Rome Cloud", async () => {
    await deps.dashboardAccessStore.save({ cloudEmailAccess: ["ada@example.com"] });
    dashboardAccessState.setCloudEmailAccess(["ada@example.com"]);
    const pushed: unknown[] = [];
    deps.visitorAllowListSync.push = (list) => void pushed.push(list);
    testDb.db.run(
      sql`CREATE TRIGGER members_down BEFORE INSERT ON members BEGIN SELECT RAISE(ABORT, 'members down'); END`,
    );

    const res = await app.request("/dashboard-access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloudEmailAccess: ["ada@example.com", "lin@example.com"] }),
    });

    expect(res.status).toBe(500);
    expect([...dashboardAccessState.cloudEmails()]).toEqual(["ada@example.com"]);
    expect(pushed).toEqual([]);
    expect(await deps.dashboardAccessStore.read()).toEqual({
      emails: ["ada@example.com"],
      revision: 1,
    });
  });

  it("fails the save when the settings record cannot be written, and changes no member, no snapshot and nothing Rome Cloud hears", async () => {
    await deps.dashboardAccessStore.save({ cloudEmailAccess: ["ada@example.com"] });
    await dashboardAccessState.load(testDb.db);
    const pushed: unknown[] = [];
    deps.visitorAllowListSync.push = (list) => void pushed.push(list);
    testDb.db.run(
      sql`CREATE TRIGGER settings_down BEFORE UPDATE ON settings WHEN NEW.key = 'dashboardAccess' BEGIN SELECT RAISE(ABORT, 'settings down'); END`,
    );

    const res = await app.request("/dashboard-access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloudEmailAccess: ["lin@example.com"] }),
    });

    expect(res.status).toBe(500);
    expect(
      (await listMembers(memberContext(testDb.db))).flatMap((m) =>
        m.accounts.map((a) => a.accountId),
      ),
    ).toEqual(["ada@example.com"]);
    expect([...dashboardAccessState.cloudEmails()]).toEqual(["ada@example.com"]);
    expect(dashboardAccessState.isCloudEmailAllowed("ada@example.com")).toBe(true);
    expect(pushed).toEqual([]);
    expect(await deps.dashboardAccessStore.read()).toEqual({
      emails: ["ada@example.com"],
      revision: 1,
    });
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
