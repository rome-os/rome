import { afterAll, afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { visitorAuthRoutes, type VisitorAuthSeams } from "./visitor-auth.js";
import { VisitorProfilesRepository } from "../../db/repositories/visitor-profiles.js";
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

function mockAccountSession(email: string, accountId = "acct-1"): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        accountId,
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

// The attempt cookie each start set, keyed by its state, so `callback` can
// replay it the way the browser that started the attempt would.
const loginCookies = new Map<string, string>();

// Record the attempt cookie a start response set, and return its state.
async function recordAttempt(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")?.match(/rome_visitor_login_state=[^;]+/)?.[0];
  expect(cookie).toBeTruthy();
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  const state = new URL(authorizeUrl).searchParams.get("state");
  expect(state).toBeTruthy();
  loginCookies.set(state as string, cookie as string);
  return state as string;
}

// GET the callback from the browser that started the attempt for this state.
function callback(app: Hono, path: string): Promise<Response> {
  const state = new URL(path, "http://instance.test").searchParams.get("state");
  const cookie = state ? loginCookies.get(state) : undefined;
  return Promise.resolve(app.request(path, cookie ? { headers: { cookie } } : undefined));
}

async function startDashboardLogin(app: Hono): Promise<string> {
  const res = await app.request("/api/auth/visitor/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "dashboard", next: "/settings/advanced" }),
  });
  return recordAttempt(res);
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

    const res = await callback(app, `/api/auth/visitor/callback?state=${nonce}&code=abc`);

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

  it("keeps the signed-in profile so chat can show who sent a message", async () => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    const app = await buildRoute(state, { fetchImpl: mockAccountSession("Ada@Example.com") });
    const nonce = await startDashboardLogin(app);

    await app.request(`/api/auth/visitor/callback?state=${nonce}&code=abc`);

    const profiles = await new VisitorProfilesRepository(testDb.db).getMany(["acct-1"]);
    expect(profiles.get("acct-1")).toEqual({
      email: "ada@example.com",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it("keeps no profile for a sign-in the allow-list refuses", async () => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    const app = await buildRoute(state, {
      fetchImpl: mockAccountSession("lin@example.com", "acct-lin"),
    });
    const nonce = await startDashboardLogin(app);

    await app.request(`/api/auth/visitor/callback?state=${nonce}&code=abc`);

    const profiles = await new VisitorProfilesRepository(testDb.db).getMany(["acct-lin"]);
    expect(profiles.size).toBe(0);
  });

  it.each([
    "lin@example.com",
    "Lin+Work@Example.com",
  ])("identifies the rejected dashboard account %s without granting access", async (email) => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    const app = await buildRoute(state, { fetchImpl: mockAccountSession(email) });
    const nonce = await startDashboardLogin(app);

    const res = await callback(
      app,
      `/api/auth/visitor/callback?state=${nonce}&code=abc&email=ada%40example.com`,
    );

    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location")!, "https://rome.example.com");
    expect(`${target.pathname}${target.search}`).toBe("/login?visitor=error&reason=forbidden");
    expect(new URLSearchParams(target.hash.slice(1)).get("email")).toBe(email.toLowerCase());
    expect(target.toString()).not.toContain("ada");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie") ?? "").not.toContain(`${VISITOR_COOKIE_NAME}=`);
  });

  it("does not include an account when the account session is malformed", async () => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    const app = await buildRoute(state, { fetchImpl: mockAccountSession("") });
    const nonce = await startDashboardLogin(app);

    const res = await callback(
      app,
      `/api/auth/visitor/callback?state=${nonce}&code=abc&email=ada%40example.com`,
    );

    expect(res.headers.get("location")).toBe("/login?visitor=error&reason=malformed");
    expect(res.headers.get("set-cookie") ?? "").not.toContain(`${VISITOR_COOKIE_NAME}=`);
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

    const state = await recordAttempt(await startAppLogin(app, "haiku-commission"));

    const res = await callback(app, `/api/auth/visitor/callback?state=${state}&code=abc`);

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

// The start route binds each attempt to the browser that ran it, so a callback
// URL lifted from one browser can't sign another browser in (login CSRF).
describe("/api/auth/visitor callback browser binding", () => {
  async function allowedApp(): Promise<Hono> {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    return buildRoute(state, { fetchImpl: mockAccountSession("ada@example.com") });
  }

  it("clears the attempt cookie when the sign-in completes", async () => {
    const app = await allowedApp();
    const state = await startDashboardLogin(app);

    const res = await callback(app, `/api/auth/visitor/callback?state=${state}&code=abc`);

    expect(res.headers.get("location")).toBe("/settings/advanced");
    const cleared = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("rome_visitor_login_state="));
    expect(cleared).toMatch(/^rome_visitor_login_state=;/);
    expect(cleared).toContain("Max-Age=0");
  });

  it("refuses a callback without the attempt cookie and burns the attempt", async () => {
    const app = await allowedApp();
    const state = await startDashboardLogin(app);
    const path = `/api/auth/visitor/callback?state=${state}&code=abc`;

    const res = await app.request(path);

    expect(res.headers.get("location")).toBe("/login?visitor=error&reason=state");
    expect(res.headers.get("set-cookie") ?? "").not.toContain(`${VISITOR_COOKIE_NAME}=`);
    // The attempt is consumed, so the starting browser can't replay it either.
    const replay = await callback(app, path);
    expect(replay.headers.get("location")).toBe("/?visitor=error&reason=state");
  });

  it("refuses a callback carrying another attempt's cookie", async () => {
    const app = await allowedApp();
    const attacker = await startDashboardLogin(app);
    const victim = await startDashboardLogin(app);

    const res = await app.request(`/api/auth/visitor/callback?state=${attacker}&code=abc`, {
      headers: { cookie: loginCookies.get(victim) as string },
    });

    expect(res.headers.get("location")).toBe("/login?visitor=error&reason=state");
    expect(res.headers.get("set-cookie") ?? "").not.toContain(`${VISITOR_COOKIE_NAME}=`);
  });

  it("leaves the attempt cookie alone on a stray callback", async () => {
    const app = await allowedApp();
    const state = await startDashboardLogin(app);

    const stray = await app.request("/api/auth/visitor/callback?state=unknown&code=abc", {
      headers: { cookie: loginCookies.get(state) as string },
    });
    expect(stray.headers.get("location")).toBe("/?visitor=error&reason=state");
    expect(stray.headers.get("set-cookie")).toBeNull();

    const res = await callback(app, `/api/auth/visitor/callback?state=${state}&code=abc`);
    expect(res.headers.get("location")).toBe("/settings/advanced");
  });
});
