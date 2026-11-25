/**
 * Every dashboard route is behind the entry step, or needs no entry: it is on
 * the public list, or it is an app's. A route added anywhere under /api is in
 * one of the two, so this reads the routes off the app itself.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import type { Hono } from "hono";
import {
  COOKIE_NAME,
  VISITOR_COOKIE_NAME,
  createSession,
  createVisitorSession,
} from "../access/auth.js";
import { guardianAuth } from "../db/schema.js";
import { buildTestDeps, createTestDb } from "../test/helpers.js";
import { buildApp } from "./index.js";
import { needsNoEntry } from "./ways-in.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

/** One request for each route under /api, its parameters filled in. */
function dashboardRequests(app: Hono): Array<{ method: string; path: string }> {
  const seen = new Map<string, { method: string; path: string }>();
  for (const route of app.routes) {
    if (!route.path.startsWith("/api/") || route.path === "/api/*") continue;
    const path = route.path
      .replace(/:(\w+)(\{[^}]*\})?\??/g, (_, name: string) => `some-${name.toLowerCase()}`)
      .replace(/\*$/, "rest");
    const method = route.method === "ALL" ? "GET" : route.method;
    seen.set(`${method} ${path}`, { method, path });
  }
  return [...seen.values()];
}

const cookieOf = {
  guardian: () => `${COOKIE_NAME}=${createSession("guardian-1")}`,
  member: () => `${VISITOR_COOKIE_NAME}=${createVisitorSession("acct-1", "ada@example.com")}`,
  guest: () => `${VISITOR_COOKIE_NAME}=${createVisitorSession("acct-2", "guest@example.com")}`,
};

describe("the dashboard's entry step", () => {
  let app: Hono;
  let members: Awaited<ReturnType<typeof buildTestDeps>>["dashboardAccessState"];
  let behind: ReturnType<typeof dashboardRequests>;

  beforeAll(async () => {
    const deps = await buildTestDeps(testDb.db);
    members = deps.dashboardAccessState;
    members.setCloudEmailAccess(["ada@example.com"]);
    app = buildApp(deps, { port: 0, host: "127.0.0.1" }).app;
    behind = dashboardRequests(app).filter(({ path }) => !needsNoEntry(path));
  });

  const answer = async (
    { method, path }: { method: string; path: string },
    cookie?: string,
    env?: object,
  ) => {
    const res = await app.request(path, { method, headers: cookie ? { cookie } : {} }, env);
    await res.body?.cancel();
    return res.status;
  };

  it("refuses anyone who is not a member on every route that needs entry", async () => {
    expect(behind.length).toBeGreaterThan(150);
    for (const request of behind) {
      const name = `${request.method} ${request.path}`;
      expect(await answer(request), name).toBe(401);
      expect(await answer(request, cookieOf.guest()), name).toBe(403);
    }
  });

  it("refuses a path it does not know, and lets a member see it is not there", async () => {
    const unknown = { method: "GET", path: "/api/no-such-thing" };
    expect(await answer(unknown)).toBe(401);
    expect(await answer(unknown, cookieOf.guest())).toBe(403);
    expect(await answer(unknown, cookieOf.member())).toBe(404);
    expect(await answer(unknown, cookieOf.guardian())).toBe(404);
  });

  it("refuses everyone but the guardian as no one while there are no members", async () => {
    members.setCloudEmailAccess([]);
    const settings = { method: "GET", path: "/api/settings" };
    expect(await answer(settings, cookieOf.member())).toBe(401);
    expect(await answer(settings, cookieOf.guardian())).toBe(200);
    members.setCloudEmailAccess(["ada@example.com"]);
  });

  it("lets a loopback caller in as the guardian's seat, and no proxied one", async () => {
    const settings = { method: "GET", path: "/api/settings" };
    const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    expect(await answer(settings, undefined, peer)).toBe(401);
    testDb.db
      .insert(guardianAuth)
      .values({
        id: "g1",
        userId: "guardian-1",
        passwordHash: "unused",
        onboardingComplete: true,
        createdAt: new Date(),
      })
      .run();
    expect(await answer(settings, undefined, peer)).toBe(200);
    const proxied = await app.request(
      "/api/settings",
      { headers: { "X-Forwarded-For": "203.0.113.7" } },
      peer,
    );
    expect(proxied.status).toBe(401);
  });

  it("leaves only these routes to need no entry", () => {
    const open = dashboardRequests(app)
      .filter(({ path }) => needsNoEntry(path))
      .map(({ method, path }) => `${method} ${path}`)
      .sort();
    expect(open).toEqual([
      "GET /api/app-api/rest",
      "GET /api/apps/some-appid/icon",
      "GET /api/apps/some-appid/manifest",
      "GET /api/apps/some-appid/rest",
      "GET /api/auth/cloud/callback",
      "GET /api/auth/me",
      "GET /api/auth/verify",
      "GET /api/auth/visitor/callback",
      "GET /api/bootstrap",
      "GET /api/health",
      "GET /api/instance/enroll/callback",
      "GET /api/instance/enroll/status",
      "GET /api/oauth/providers",
      "GET /api/oauth/some-provider/start",
      "GET /api/share/rest",
      "GET /api/share/some-token",
      "GET /api/share/some-token/projects/asset",
      "GET /api/share/some-token/projects/asset/some-filename",
      "GET /api/share/some-token/projects/download",
      "GET /api/share/some-token/projects/file",
      "GET /api/share/some-token/projects/resolve",
      "GET /api/share/some-token/projects/search",
      "GET /api/share/some-token/projects/tree",
      "GET /api/uptime",
      "POST /api/auth/cloud/native/complete",
      "POST /api/auth/cloud/native/start",
      "POST /api/auth/cloud/start",
      "POST /api/auth/login",
      "POST /api/auth/logout",
      "POST /api/auth/visitor/logout",
      "POST /api/auth/visitor/native/complete",
      "POST /api/auth/visitor/native/start",
      "POST /api/auth/visitor/start",
      "POST /api/instance/adopt",
      "POST /api/instance/enroll/start",
      "POST /api/oauth/redeem",
      "POST /api/oauth/some-provider/start",
      "POST /api/onboard/complete",
      "POST /api/onboard/create-account",
      "POST /api/setups/return",
    ]);
  });
});
