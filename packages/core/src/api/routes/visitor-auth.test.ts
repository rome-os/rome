import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { approvalsRoutes } from "./approvals.js";
import { sessionActorMiddleware } from "../../lib/session-actor.js";
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

    const res = await app.request(
      `/api/auth/visitor/callback?state=${nonce}&code=abc&email=ada%40example.com`,
    );

    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location")!, "https://rome.example.com");
    expect(`${target.pathname}${target.search}`).toBe("/login?visitor=error&reason=forbidden");
    expect(new URLSearchParams(target.hash.slice(1)).get("email")).toBe(email.toLowerCase());
    expect(target.toString()).not.toContain("ada");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("does not include an account when the account session is malformed", async () => {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    const app = await buildRoute(state, { fetchImpl: mockAccountSession("") });
    const nonce = await startDashboardLogin(app);

    const res = await app.request(
      `/api/auth/visitor/callback?state=${nonce}&code=abc&email=ada%40example.com`,
    );

    expect(res.headers.get("location")).toBe("/login?visitor=error&reason=malformed");
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

describe("/api/auth/visitor/native", () => {
  interface NativeStart {
    visitor_authorization_request: Record<string, string>;
    origin: string;
    expires_at: string;
  }

  function allowList(...emails: string[]): DashboardAccessState {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(emails);
    return state;
  }

  // Records the code exchange so a test can check the verifier matches the challenge.
  function recordingAccountSession(
    email: string,
    opts: { status?: number; body?: Record<string, unknown> } = {},
  ) {
    const exchanges: Array<{ url: string; body: { code: string; code_verifier: string } }> = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      exchanges.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify(
          opts.body ?? {
            accountId: "acct-1",
            email,
            avatarUrl: "https://example.com/avatar.png",
            favorViewerToken: "favor-token",
          },
        ),
        { status: opts.status ?? 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { exchanges, fetchImpl };
  }

  async function nativeStart(app: Hono): Promise<NativeStart> {
    const res = await app.request("/api/auth/visitor/native/start", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    return (await res.json()) as NativeStart;
  }

  function nativeComplete(app: Hono, body: Record<string, unknown>): Promise<Response> {
    return Promise.resolve(
      app.request("/api/auth/visitor/native/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("refuses to start without a dashboard allow-list", async () => {
    const app = await buildRoute(new DashboardAccessState());

    const res = await app.request("/api/auth/visitor/native/start", { method: "POST" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "dashboard_not_cloud_email_restricted" });
  });

  it("returns a PKCE-bound visitor authorization request without the verifier", async () => {
    const app = await buildRoute(allowList("ada@example.com"));

    const body = await nativeStart(app);

    expect(body.visitor_authorization_request).toMatchObject({
      code_challenge_method: "S256",
      intent: "signin",
    });
    expect(body.visitor_authorization_request.redirect_uri).toContain("/api/auth/visitor/callback");
    expect(body.visitor_authorization_request.state).toBeTruthy();
    expect(body.visitor_authorization_request.code_challenge).toBeTruthy();
    expect(body.visitor_authorization_request.instance_name).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("verifier");
    expect(body.origin).toBeTruthy();
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns a visitor session for an allow-listed visitor without setting a cookie", async () => {
    const cloud = recordingAccountSession("Ada@Example.com");
    const app = await buildRoute(allowList("ada@example.com"), { fetchImpl: cloud.fetchImpl });
    const { visitor_authorization_request: request } = await nativeStart(app);

    const res = await nativeComplete(app, { state: request.state, code: "abc" });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, string>;
    expect(body).toMatchObject({ cookie_name: VISITOR_COOKIE_NAME, role: "visitor" });
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(body.origin).toBeTruthy();
    expect(verifyVisitorSession(body.session_token)).toMatchObject({
      accountId: "acct-1",
      email: "ada@example.com",
      favorViewerToken: "favor-token",
    });

    // The exchange carries the verifier whose S256 hash is the challenge.
    expect(cloud.exchanges).toHaveLength(1);
    expect(cloud.exchanges[0].url).toBe("http://localhost:3100/api/account/session");
    const verifier = cloud.exchanges[0].body.code_verifier;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(request.code_challenge);
    const profiles = await new VisitorProfilesRepository(testDb.db).getMany(["acct-1"]);
    expect(profiles.get("acct-1")?.email).toBe("ada@example.com");

    const replay = await nativeComplete(app, { state: request.state, code: "abc" });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_state" });
  });

  it("refuses a visitor the instance's own allow-list does not name", async () => {
    const cloud = recordingAccountSession("lin@example.com");
    const app = await buildRoute(allowList("ada@example.com"), { fetchImpl: cloud.fetchImpl });
    const { visitor_authorization_request: request } = await nativeStart(app);

    const res = await nativeComplete(app, { state: request.state, code: "abc" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_allowed" });
  });

  it("refuses a malformed account session and a refused code", async () => {
    const malformed = recordingAccountSession("ada@example.com", {
      body: { accountId: "acct-1", email: "ada@example.com" },
    });
    const app = await buildRoute(allowList("ada@example.com"), {
      fetchImpl: malformed.fetchImpl,
    });
    const first = (await nativeStart(app)).visitor_authorization_request;
    const res = await nativeComplete(app, { state: first.state, code: "abc" });
    expect(res.status).toBe(502);

    const refused = recordingAccountSession("ada@example.com", { status: 400 });
    const app2 = await buildRoute(allowList("ada@example.com"), { fetchImpl: refused.fetchImpl });
    const second = (await nativeStart(app2)).visitor_authorization_request;
    const res2 = await nativeComplete(app2, { state: second.state, code: "abc" });
    expect(res2.status).toBe(400);
    expect(await res2.json()).toEqual({ error: "invalid_grant" });
  });

  it("keeps native and browser attempts apart", async () => {
    const cloud = recordingAccountSession("ada@example.com");
    const app = await buildRoute(allowList("ada@example.com"), { fetchImpl: cloud.fetchImpl });

    // A native attempt cannot finish at the browser callback, and stays usable.
    const native = (await nativeStart(app)).visitor_authorization_request;
    const atCallback = await app.request(
      `/api/auth/visitor/callback?state=${native.state}&code=abc`,
    );
    expect(atCallback.status).toBe(302);
    expect(atCallback.headers.get("location")).toBe("/?visitor=error&reason=state");
    expect(atCallback.headers.get("set-cookie")).toBeNull();

    // A browser attempt cannot finish at the native endpoint, and stays usable.
    const browserState = await startDashboardLogin(app);
    const atNative = await nativeComplete(app, { state: browserState, code: "abc" });
    expect(atNative.status).toBe(400);
    expect(await atNative.json()).toEqual({ error: "invalid_state" });
    expect(cloud.exchanges).toHaveLength(0);

    expect((await nativeComplete(app, { state: native.state, code: "abc" })).status).toBe(200);
    const browser = await app.request(`/api/auth/visitor/callback?state=${browserState}&code=abc`);
    expect(browser.headers.get("location")).toBe("/settings/advanced");
  });

  it("gives approvals a native visitor session that they refuse", async () => {
    const cloud = recordingAccountSession("ada@example.com");
    const app = await buildRoute(allowList("ada@example.com"), { fetchImpl: cloud.fetchImpl });
    const { visitor_authorization_request: request } = await nativeStart(app);
    const { session_token: token } = (await (
      await nativeComplete(app, { state: request.state, code: "abc" })
    ).json()) as { session_token: string };

    const api = new Hono();
    api.use("*", sessionActorMiddleware(testDb.db));
    api.route("/", approvalsRoutes(await buildTestDeps(testDb.db)));
    const cookie = `${VISITOR_COOKIE_NAME}=${token}`;

    expect((await api.request("/approvals", { headers: { cookie } })).status).toBe(403);
    expect(
      (await api.request("/approvals/any/approve", { method: "POST", headers: { cookie } })).status,
    ).toBe(403);
  });
});

describe("/api/auth/visitor — resending the allow-list after a first sign-in", () => {
  async function routeWith(email: string): Promise<{ app: Hono; resends: () => number }> {
    const state = new DashboardAccessState();
    state.setCloudEmailAccess(["ada@example.com"]);
    const deps = { ...(await buildTestDeps(testDb.db)), dashboardAccessState: state };
    // Clearing the list forgets earlier tests' sign-ins in this shared database.
    await deps.dashboardAccessStore.save({ cloudEmailAccess: [] });
    await deps.dashboardAccessStore.save({ cloudEmailAccess: ["ada@example.com"] });
    let count = 0;
    deps.visitorAllowListSync.requestResend = () => void (count += 1);
    const app = new Hono();
    app.route("/api", visitorAuthRoutes(deps, { fetchImpl: mockAccountSession(email) }));
    return { app, resends: () => count };
  }

  async function browserSignIn(app: Hono): Promise<void> {
    const nonce = await startDashboardLogin(app);
    await app.request(`/api/auth/visitor/callback?state=${nonce}&code=abc`);
  }

  async function nativeSignIn(app: Hono): Promise<void> {
    const start = await app.request("/api/auth/visitor/native/start", { method: "POST" });
    const { visitor_authorization_request: request } = (await start.json()) as {
      visitor_authorization_request: { state: string };
    };
    await app.request("/api/auth/visitor/native/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: request.state, code: "abc" }),
    });
  }

  it("resends once on a listed email's first sign-in, browser or native, and never after", async () => {
    const { app, resends } = await routeWith("Ada@Example.com");
    await nativeSignIn(app);
    expect(resends()).toBe(1);
    await browserSignIn(app);
    await nativeSignIn(app);
    expect(resends()).toBe(1);
  });

  it("resends nothing for a sign-in the allow-list refuses", async () => {
    const { app, resends } = await routeWith("lin@example.com");
    await browserSignIn(app);
    expect(resends()).toBe(0);
  });
});
