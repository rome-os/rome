import { afterAll, afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { visitorAuthRoutes, type VisitorAuthSeams } from "./visitor-auth.js";
import { VISITOR_COOKIE_NAME, verifyVisitorSession } from "../../lib/auth.js";
import { DashboardAccessState } from "../../lib/dashboard-access-state.js";
import { PublicAccessState } from "../../lib/public-access-state.js";
import { buildTestDeps, createTestDb, type TestDeps } from "../../test/helpers.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

const ENV_KEYS = ["PANTHEON_BASE_ORIGIN"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.PANTHEON_BASE_ORIGIN = "http://localhost:3100";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function mockAccountSession(email: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        accountId: "acct-1",
        email,
        avatarUrl: "https://example.com/avatar.png",
        favorViewerToken: "favor-token",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as typeof fetch;
}

async function buildRoute(
  dashboardAccessState: DashboardAccessState,
  seams: VisitorAuthSeams = {},
  overrides: Partial<TestDeps> = {},
): Promise<Hono> {
  const deps = {
    ...(await buildTestDeps(testDb.db)),
    dashboardAccessState,
    ...overrides,
  };
  const app = new Hono();
  app.route("/api", visitorAuthRoutes(deps, seams));
  return app;
}

async function startDashboardLogin(app: Hono): Promise<string> {
  const res = await app.request("/api/auth/visitor/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "dashboard", next: "/settings/advanced" }),
  });
  expect(res.status).toBe(200);
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  const state = new URL(authorizeUrl).searchParams.get("state");
  expect(state).toBeTruthy();
  return state as string;
}

describe("/api/auth/visitor dashboard access", () => {
  it("does not start dashboard visitor auth without a dashboard allow-list", async () => {
    const app = await buildRoute(new DashboardAccessState());
    const res = await app.request("/api/auth/visitor/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "dashboard", next: "/" }),
    });
    expect(res.status).toBe(404);
  });

  it("issues a visitor cookie and returns to the dashboard for an allowed email", async () => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    const app = await buildRoute(state, { fetchImpl: mockAccountSession("Ada@Example.com") });
    const nonce = await startDashboardLogin(app);

    const res = await app.request(`/api/auth/visitor/callback?state=${nonce}&code=abc`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings/advanced");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${VISITOR_COOKIE_NAME}=`);
    const token = cookie.match(new RegExp(`${VISITOR_COOKIE_NAME}=([^;]+)`))?.[1];
    expect(verifyVisitorSession(decodeURIComponent(token ?? ""))).toMatchObject({
      accountId: "acct-1",
      email: "ada@example.com",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it("rejects dashboard visitor callback when the email is not allowed", async () => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    const app = await buildRoute(state, { fetchImpl: mockAccountSession("lin@example.com") });
    const nonce = await startDashboardLogin(app);

    const res = await app.request(`/api/auth/visitor/callback?state=${nonce}&code=abc`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?visitor=error&reason=forbidden");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("/api/auth/visitor logout", () => {
  it("expires the visitor cookie without touching the guardian session cookie", async () => {
    const app = await buildRoute(new DashboardAccessState());

    const res = await app.request("/api/auth/visitor/logout", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${VISITOR_COOKIE_NAME}=;`);
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).not.toContain("rome_session");
  });
});

describe("/api/auth/visitor app access", () => {
  function publicAccess(config: {
    allowedApps?: string[];
    cloudEmailAccess?: Record<string, string[]>;
  }): PublicAccessState {
    const state = new PublicAccessState();
    state.setConfig({
      allowedApps: config.allowedApps ?? [],
      cloudEmailAccess: config.cloudEmailAccess ?? {},
    });
    return state;
  }

  async function startAppLogin(app: Hono, appId: string): Promise<Response> {
    return app.request("/api/auth/visitor/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, next: `/full/apps/${appId}` }),
    });
  }

  it("does not start visitor auth for a private app", async () => {
    const app = await buildRoute(
      new DashboardAccessState(),
      {},
      {
        publicAccessState: publicAccess({}),
      },
    );

    const res = await startAppLogin(app, "haiku-commission");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "app_not_publicly_accessible" });
  });

  it("starts visitor auth for a link-public app so favor requests can identify the visitor", async () => {
    const app = await buildRoute(
      new DashboardAccessState(),
      { fetchImpl: mockAccountSession("bob@example.com") },
      { publicAccessState: publicAccess({ allowedApps: ["haiku-commission"] }) },
    );

    const startRes = await startAppLogin(app, "haiku-commission");
    expect(startRes.status).toBe(200);
    const { authorizeUrl } = (await startRes.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    const res = await app.request(`/api/auth/visitor/callback?state=${state}&code=abc`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/full/apps/haiku-commission");
    expect(res.headers.get("set-cookie")).toContain(`${VISITOR_COOKIE_NAME}=`);
  });

  it("still starts visitor auth for a cloud-email app", async () => {
    const app = await buildRoute(
      new DashboardAccessState(),
      {},
      {
        publicAccessState: publicAccess({
          cloudEmailAccess: { "haiku-commission": ["ada@example.com"] },
        }),
      },
    );

    const res = await startAppLogin(app, "haiku-commission");

    expect(res.status).toBe(200);
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    expect(new URL(authorizeUrl).pathname).toBe("/instance/authorize");
  });
});
