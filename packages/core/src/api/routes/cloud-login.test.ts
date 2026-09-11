/**
 * `/api/auth/cloud/*` — the cloud guardian sign-in, driving the
 * standard OAuth surface. Driven end-to-end over HTTP: POST start to
 * get the Rome Cloud `/oauth2/authorize` URL (and the CSRF state + nonce), then
 * GET the callback with that state. The Rome Cloud legs — the `/oauth2/token`
 * exchange and the `/oauth2/jwks` fetch inside `verifyIdToken` — are served by a
 * fake Rome Cloud that signs real ES256 id_tokens, so the flow (including signature
 * verification) runs without a live Rome Cloud.
 *
 * Behaviors pinned here:
 *   - start requests scope `openid instance:enroll` on a vanilla box (mint the
 *     token at the token leg) and `openid` on an already-enrolled box.
 *   - vanilla instance: callback enrolls (persists the instance token), stamps the
 *     guardian account from the verified id_token, and issues a session. When no
 *     guardian seat exists it is created from the cloud account, setup finishes
 *     with defaults (the guardian name from the `name` claim or the email local
 *     part, a preset agent), and the browser lands on the welcome conversation.
 *   - bound instance: a session is issued for the verified account, and that
 *     account is stamped as the binding (repairing a null/stale recorded owner).
 *     Ownership is enforced server-side at /authorize, so the verified `sub` is the
 *     owner — there is no client-side cross-account reconciliation.
 *   - id_token that fails verification (bad signature, wrong issuer, nonce
 *     mismatch): fail closed, no cookie.
 *   - token exchange failure, `iss` mismatch, and a state echo that matches no
 *     pending attempt: rejected, no cookie.
 *   - flag off: start and callback both 404.
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import jwt from "jsonwebtoken";

// The seat creation writes the guardian's profile notes; keep them out of the
// runner's real profile.
rs.mock("../../profile-memory.js", () => ({
  ensureProfileMemoryInitialized: rs.fn(() => mkdtempSync(join(tmpdir(), "cloud-login-"))),
}));

import { type CloudLoginSeams, cloudLoginRoutes } from "./cloud-login.js";
import { AGENT_PRESETS } from "../../lib/agent-presets.js";
import { visitorAuthRoutes } from "./visitor-auth.js";
import { COOKIE_NAME, JWT_SECRET, VISITOR_COOKIE_NAME } from "../../lib/auth.js";
import { DashboardAccessState } from "../../lib/dashboard-access-state.js";
import {
  INSTANCE_TOKEN_SETTING_KEY,
  setInstanceTokenInMemory,
} from "../../lib/instance-identity.js";
import { guardianAuth, persons, settings } from "../../db/schema.js";
import { buildTestDeps, createTestDb, type TestDeps } from "../../test/helpers.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

const ISSUER = "http://localhost:3100";
// Rome Cloud always appends `iss` to the callback (RFC 9207); the callback now
// requires it, so the happy-path requests carry it.
const ISS = encodeURIComponent(ISSUER);
const ENV_KEYS = ["PANTHEON_BASE_ORIGIN"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  testDb.db.delete(guardianAuth).run();
  testDb.db.delete(persons).run();
  testDb.db.delete(settings).run();
  setInstanceTokenInMemory(null);
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.PANTHEON_BASE_ORIGIN = ISSUER;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// One stable ES256 signing key for the whole file; its public half is served at
// /oauth2/jwks under `kid`. A second throwaway key models a bad signature.
const KID = "test-kid";
function makeKey(): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as object),
    kid: KID,
    use: "sig",
    alg: "ES256",
  };
  return { privateKey, jwk };
}
const KEY = makeKey();
const WRONG_KEY = makeKey();

function signIdToken(opts: {
  sub: string;
  nonce?: string | null;
  issuer?: string;
  audience?: string;
  key?: KeyObject;
  email?: string;
  picture?: string;
  name?: string;
}): string {
  const payload: Record<string, unknown> = {};
  if (opts.nonce) payload.nonce = opts.nonce;
  if (opts.email) payload.email = opts.email;
  if (opts.picture) payload.picture = opts.picture;
  if (opts.name) payload.name = opts.name;
  return jwt.sign(payload, opts.key ?? KEY.privateKey, {
    algorithm: "ES256",
    keyid: KID,
    subject: opts.sub,
    audience: opts.audience ?? "rome-instance",
    issuer: opts.issuer ?? ISSUER,
    expiresIn: 300,
  });
}

// A fake Rome Cloud: serves the JWKS and the token exchange. `tokenBody` is called
// with the nonce captured from the authorize URL, so the signed id_token can echo
// it. `setNonce` is called by the test after `start`.
function fakeRomeCloud(
  tokenBody: (nonce: string | null) => Record<string, unknown>,
  opts: { tokenStatus?: number; jwks?: unknown } = {},
): { fetch: typeof fetch; setNonce(nonce: string | null): void } {
  let nonce: string | null = null;
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = String(input instanceof URL ? input : ((input as Request).url ?? input));
    if (url.endsWith("/oauth2/jwks")) {
      return new Response(JSON.stringify(opts.jwks ?? { keys: [KEY.jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/oauth2/token")) {
      return new Response(JSON.stringify(tokenBody(nonce)), {
        status: opts.tokenStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, setNonce: (n) => (nonce = n) };
}

function insertGuardian(
  opts: {
    userId?: string;
    accountId?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  } = {},
): void {
  testDb.db
    .insert(guardianAuth)
    .values({
      id: "g1",
      userId: opts.userId ?? "guardian",
      passwordHash: "unused",
      accountId: opts.accountId ?? null,
      email: opts.email ?? null,
      avatarUrl: opts.avatarUrl ?? null,
      onboardingComplete: true,
      createdAt: new Date(),
    })
    .run();
}

async function buildRoute(
  seams: CloudLoginSeams,
  overrides: Partial<TestDeps> = {},
): Promise<Hono> {
  const deps = {
    ...(await buildTestDeps(testDb.db)),
    isCloudAuthEnabled: async () => true,
    ...overrides,
  };
  const app = new Hono();
  app.route("/api", cloudLoginRoutes(deps, seams));
  return app;
}

// Run start, return the CSRF state + the nonce minted into the authorize URL.
async function start(app: Hono): Promise<{ state: string; nonce: string; scope: string }> {
  const res = await app.request("/api/auth/cloud/start", { method: "POST" });
  expect(res.status).toBe(200);
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  const url = new URL(authorizeUrl);
  const state = url.searchParams.get("state");
  const nonce = url.searchParams.get("nonce");
  const scope = url.searchParams.get("scope");
  expect(state).toBeTruthy();
  expect(nonce).toBeTruthy();
  return { state: state as string, nonce: nonce as string, scope: scope as string };
}

async function nativeStart(app: Hono): Promise<{
  state: string;
  nonce: string;
  authorizationRequest: Record<string, string>;
}> {
  const res = await app.request("/api/auth/cloud/native/start", { method: "POST" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    authorization_request: Record<string, string>;
    origin: string;
    expires_at: string;
  };
  expect(body.origin).toBeTruthy();
  expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  return {
    state: body.authorization_request.state,
    nonce: body.authorization_request.nonce,
    authorizationRequest: body.authorization_request,
  };
}

function sessionUserId(res: Response): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const decoded = jwt.verify(decodeURIComponent(match[1]), JWT_SECRET) as { userId?: string };
  return decoded.userId ?? null;
}

describe("/api/auth/cloud — flag off", () => {
  it("404s start and callback when cloud auth is off", async () => {
    const deps = await buildTestDeps(testDb.db);
    const app = new Hono();
    app.route("/api", cloudLoginRoutes(deps)); // isCloudAuthEnabled default is false

    const startRes = await app.request("/api/auth/cloud/start", { method: "POST" });
    expect(startRes.status).toBe(404);

    const callback = await app.request("/api/auth/cloud/callback?state=x&code=y");
    expect(callback.status).toBe(404);
  });
});

describe("/api/auth/cloud/native", () => {
  it("requires an enrolled instance before creating a native authorization request", async () => {
    setInstanceTokenInMemory(null);
    const app = await buildRoute({ fetchImpl: fakeRomeCloud(() => ({})).fetch });

    const res = await app.request("/api/auth/cloud/native/start", { method: "POST" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "instance_not_enrolled" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a PKCE-bound instance authorization request without exposing the verifier", async () => {
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildRoute({ fetchImpl: fakeRomeCloud(() => ({})).fetch });

    const { authorizationRequest } = await nativeStart(app);

    expect(authorizationRequest).toMatchObject({
      response_type: "code",
      client_id: "rome-instance",
      scope: "openid",
      code_challenge_method: "S256",
    });
    expect(authorizationRequest.redirect_uri).toContain("/api/auth/cloud/callback");
    expect(authorizationRequest.code_challenge).toBeTruthy();
    expect(authorizationRequest).not.toHaveProperty("code_verifier");
  });

  it("exchanges the Cloud code and returns the raw Core session without setting a cookie", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({ sub: "A", nonce }),
    }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });
    const { state, nonce } = await nativeStart(app);
    romeCloud.setNonce(nonce);

    const res = await app.request("/api/auth/cloud/native/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, code: "one-time-code", iss: ISSUER }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as {
      cookie_name: string;
      session_token: string;
      expires_at: string;
      origin: string;
    };
    expect(body.cookie_name).toBe(COOKIE_NAME);
    expect(jwt.verify(body.session_token, JWT_SECRET)).toMatchObject({ userId: "A" });
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(body.origin).toBeTruthy();

    const replay = await app.request("/api/auth/cloud/native/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, code: "one-time-code", iss: ISSUER }),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_state" });
  });

  it("rejects a mismatched Rome Cloud issuer before exchanging the code", async () => {
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildRoute({ fetchImpl: fakeRomeCloud(() => ({})).fetch });
    const { state } = await nativeStart(app);

    const res = await app.request("/api/auth/cloud/native/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, code: "one-time-code", iss: "https://attacker.test" }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unverified_identity" });
  });
});

describe("/api/auth/cloud — start requests the right scope", () => {
  it("requests instance:enroll when the box has no token yet (first bind)", async () => {
    setInstanceTokenInMemory(null);
    const app = await buildRoute({ fetchImpl: fakeRomeCloud(() => ({})).fetch });
    expect((await start(app)).scope).toBe("openid instance:enroll");
  });

  it("requests plain openid when the box is already enrolled", async () => {
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildRoute({ fetchImpl: fakeRomeCloud(() => ({})).fetch });
    expect((await start(app)).scope).toBe("openid");
  });
});

describe("/api/auth/cloud — vanilla instance", () => {
  it("enrolls, binds the guardian account from the id_token, and signs in", async () => {
    insertGuardian({ accountId: null });
    const deps = { ...(await buildTestDeps(testDb.db)), isCloudAuthEnabled: async () => true };
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({ sub: "A", nonce }),
      instance_token: "romeinst_new",
      instance_id: "inst-1",
    }));
    const app = new Hono();
    app.route("/api", cloudLoginRoutes(deps, { fetchImpl: romeCloud.fetch }));

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?cloud=success");
    expect(sessionUserId(res)).toBe("A");

    expect(await deps.settingsRepo.get<string>(INSTANCE_TOKEN_SETTING_KEY)).toBe("romeinst_new");
    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.accountId).toBe("A");
  });

  it("creates the guardian seat from the cloud account when none exists", async () => {
    const deps = { ...(await buildTestDeps(testDb.db)), isCloudAuthEnabled: async () => true };
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({ sub: "A", nonce, email: "alex@example.com" }),
      instance_token: "romeinst_new",
      instance_id: "inst-1",
    }));
    const app = new Hono();
    app.route("/api", cloudLoginRoutes(deps, { fetchImpl: romeCloud.fetch }));

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/full/apps/welcome-to-rome");
    expect(sessionUserId(res)).toBe("A");

    expect(await deps.settingsRepo.get<string>(INSTANCE_TOKEN_SETTING_KEY)).toBe("romeinst_new");
    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.userId).toBe("A");
    expect(row.accountId).toBe("A");
    expect(row.onboardingComplete).toBe(true);
  });

  it("fails closed with no cookie when the token leg returns no instance token", async () => {
    insertGuardian({ accountId: null });
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=malformed");
    expect(sessionUserId(res)).toBeNull();
  });
});

describe("/api/auth/cloud — bound instance", () => {
  it("signs in as the verified account", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?cloud=success");
    expect(sessionUserId(res)).toBe("A");
  });

  it.each([
    ["null", null],
    ["stale", "OLD"],
  ])("stamps the verified account on the seat (recorded=%s)", async (_label, recorded) => {
    insertGuardian({ accountId: recorded });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?cloud=success");
    expect(sessionUserId(res)).toBe("A");
    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.accountId).toBe("A");
  });
});

describe("/api/auth/cloud — guardian profile from the id_token", () => {
  it("persists the email and picture claims when binding an existing seat", async () => {
    insertGuardian({ accountId: null });
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({
        sub: "A",
        nonce,
        email: "owner@example.com",
        picture: "https://example.com/avatar.png",
      }),
      instance_token: "romeinst_new",
      instance_id: "inst-1",
    }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.accountId).toBe("A");
    expect(row.email).toBe("owner@example.com");
    expect(row.avatarUrl).toBe("https://example.com/avatar.png");
  });

  it("stamps the profile on a freshly created cloud seat", async () => {
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({
        sub: "A",
        nonce,
        email: "owner@example.com",
        picture: "https://example.com/avatar.png",
      }),
      instance_token: "romeinst_new",
      instance_id: "inst-1",
    }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.userId).toBe("A");
    expect(row.email).toBe("owner@example.com");
    expect(row.avatarUrl).toBe("https://example.com/avatar.png");
  });

  it("keeps a recorded profile when the id_token omits optional profile claims", async () => {
    insertGuardian({
      accountId: "A",
      email: "kept@example.com",
      avatarUrl: "https://example.com/kept-avatar.png",
    });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.email).toBe("kept@example.com");
    expect(row.avatarUrl).toBe("https://example.com/kept-avatar.png");
  });
});

// A fresh seat finishes setup right in the callback, so the onboarding page is
// never reached on a cloud-default instance. The profile write is the same
// shared function `/onboard/setup` uses.
describe("/api/auth/cloud — setup finishes with defaults on a fresh seat", () => {
  async function signInFresh(claims: { name?: string; email?: string }) {
    const deps = { ...(await buildTestDeps(testDb.db)), isCloudAuthEnabled: async () => true };
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({ sub: "A", nonce, ...claims }),
      instance_token: "romeinst_new",
      instance_id: "inst-1",
    }));
    const app = new Hono();
    app.route("/api", cloudLoginRoutes(deps, { fetchImpl: romeCloud.fetch }));
    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);
    return { res, deps };
  }

  function guardianPerson() {
    return testDb.db.select().from(persons).where(eq(persons.bondLevel, "guardian")).all();
  }

  it("writes the name claim as the guardian name and redirects to the welcome app", async () => {
    const { res, deps } = await signInFresh({ name: "Alex Doe", email: "alex@example.com" });

    expect(res.headers.get("location")).toBe("/full/apps/welcome-to-rome");
    expect(await deps.settingsRepo.get<string>("guardianName")).toBe("Alex Doe");
    expect(guardianPerson()).toMatchObject([{ displayName: "Alex Doe" }]);
  });

  it("falls back to the email local part when the id_token has no name claim", async () => {
    const { deps } = await signInFresh({ email: "alex.doe@example.com" });

    expect(await deps.settingsRepo.get<string>("guardianName")).toBe("alex.doe");
    expect(guardianPerson()).toMatchObject([{ displayName: "alex.doe" }]);
  });

  it("writes a preset agent name and purpose, and marks onboarding complete", async () => {
    const { deps } = await signInFresh({ name: "Alex", email: "alex@example.com" });

    const agentName = await deps.settingsRepo.get<string>("agentName");
    const agentPurpose = await deps.settingsRepo.get<string>("agentPurpose");
    const preset = AGENT_PRESETS.find((p) => p.name === agentName);
    expect(preset).toBeDefined();
    expect(agentPurpose).toBe(preset?.purpose);
    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.onboardingComplete).toBe(true);
  });

  it("does not touch the profile of an existing seat", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const deps = { ...(await buildTestDeps(testDb.db)), isCloudAuthEnabled: async () => true };
    await deps.settingsRepo.set("guardianName", "Kept");
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({ sub: "A", nonce, name: "Someone Else" }),
    }));
    const app = new Hono();
    app.route("/api", cloudLoginRoutes(deps, { fetchImpl: romeCloud.fetch }));

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.headers.get("location")).toBe("/?cloud=success");
    expect(await deps.settingsRepo.get<string>("guardianName")).toBe("Kept");
  });
});

describe("/api/auth/cloud — id_token verification fails closed", () => {
  async function expectUnverified(romeCloud: ReturnType<typeof fakeRomeCloud>): Promise<void> {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });
    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);
    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=unverified");
    expect(sessionUserId(res)).toBeNull();
  }

  it("rejects a bad signature (token signed by an unknown key)", async () => {
    await expectUnverified(
      fakeRomeCloud((nonce) => ({
        id_token: signIdToken({ sub: "A", nonce, key: WRONG_KEY.privateKey }),
      })),
    );
  });

  it("rejects a wrong issuer", async () => {
    await expectUnverified(
      fakeRomeCloud((nonce) => ({
        id_token: signIdToken({ sub: "A", nonce, issuer: "http://evil" }),
      })),
    );
  });

  it("rejects a nonce mismatch", async () => {
    await expectUnverified(
      fakeRomeCloud(() => ({ id_token: signIdToken({ sub: "A", nonce: "not-the-real-nonce" }) })),
    );
  });
});

describe("/api/auth/cloud — request guards", () => {
  it("redirects with reason=exchange when the token leg errors", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud(() => ({ error: "invalid_grant" }), { tokenStatus: 400 });
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=exchange");
    expect(sessionUserId(res)).toBeNull();
  });

  it("rejects an iss that is not ours (RFC 9207)", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state } = await start(app);
    const res = await app.request(
      `/api/auth/cloud/callback?state=${state}&code=abc&iss=${encodeURIComponent("http://evil")}`,
    );

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=iss");
    expect(sessionUserId(res)).toBeNull();
  });

  it("rejects a callback with no iss (RFC 9207 — Rome Cloud always sends one)", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state } = await start(app);
    const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc`);

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=iss");
    expect(sessionUserId(res)).toBeNull();
  });

  it("rejects a callback whose state matches no pending attempt", async () => {
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const res = await app.request("/api/auth/cloud/callback?state=never-issued&code=abc");

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=state");
    expect(sessionUserId(res)).toBeNull();
  });
});

// Rome Cloud refuses to mint a code for a signed-in account that doesn't own the
// instance and redirects back with `error=access_denied` (+ state + iss). The
// login page has a single Rome Cloud button, so the cloud callback owns the
// fork: with a dashboard allow-list, re-route into the visitor attestation
// flow; without one, surface not_owner. Never a guardian session either way.
describe("/api/auth/cloud — not-owner dispatch (access_denied)", () => {
  // Mount the cloud and visitor routers together so the dispatch can be
  // followed end-to-end: the pending entry the dispatch mints must be
  // redeemable at the visitor callback.
  async function buildApps(opts: { emails?: string[]; accountEmail?: string } = {}): Promise<Hono> {
    const dashboardAccessState = new DashboardAccessState();
    dashboardAccessState.setCloudEmailAccess(opts.emails ?? []);
    const deps = {
      ...(await buildTestDeps(testDb.db)),
      isCloudAuthEnabled: async () => true,
      dashboardAccessState,
    };
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = String(input instanceof URL ? input : ((input as Request).url ?? input));
      if (url.endsWith("/api/account/session")) {
        return new Response(
          JSON.stringify({
            accountId: "acct-visitor",
            email: opts.accountEmail ?? "invitee@example.com",
            favorViewerToken: "favor-token",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const app = new Hono();
    app.route("/api", cloudLoginRoutes(deps, { fetchImpl }));
    app.route("/api", visitorAuthRoutes(deps, { fetchImpl }));
    return app;
  }

  it("dispatches into the dashboard visitor flow and completes it end-to-end", async () => {
    insertGuardian({ accountId: "OWNER" });
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildApps({ emails: ["invitee@example.com"] });

    const { state } = await start(app);
    const res = await app.request(
      `/api/auth/cloud/callback?state=${state}&error=access_denied&iss=${ISS}`,
    );

    expect(res.status).toBe(302);
    expect(sessionUserId(res)).toBeNull();
    const authorizeUrl = new URL(res.headers.get("location") as string);
    expect(authorizeUrl.origin).toBe(ISSUER);
    expect(authorizeUrl.pathname).toBe("/instance/authorize");
    expect(authorizeUrl.searchParams.get("intent")).toBe("signin");
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
    expect(new URL(redirectUri as string).pathname).toBe("/api/auth/visitor/callback");

    const visitorState = authorizeUrl.searchParams.get("state") as string;
    const done = await app.request(`/api/auth/visitor/callback?state=${visitorState}&code=xyz`);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/");
    expect(done.headers.get("set-cookie")).toContain(`${VISITOR_COOKIE_NAME}=`);
  });

  it("still enforces the allow-list on the dispatched flow", async () => {
    insertGuardian({ accountId: "OWNER" });
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildApps({
      emails: ["invitee@example.com"],
      accountEmail: "stranger@example.com",
    });

    const { state } = await start(app);
    const res = await app.request(
      `/api/auth/cloud/callback?state=${state}&error=access_denied&iss=${ISS}`,
    );
    const visitorState = new URL(res.headers.get("location") as string).searchParams.get(
      "state",
    ) as string;

    const done = await app.request(`/api/auth/visitor/callback?state=${visitorState}&code=xyz`);
    expect(done.headers.get("location")).toBe("/login?visitor=error&reason=forbidden");
    expect(done.headers.get("set-cookie")).toBeNull();
  });

  it("surfaces not_owner when no dashboard allow-list exists", async () => {
    insertGuardian({ accountId: "OWNER" });
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildApps();

    const { state } = await start(app);
    const res = await app.request(
      `/api/auth/cloud/callback?state=${state}&error=access_denied&iss=${ISS}`,
    );

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=not_owner");
    expect(sessionUserId(res)).toBeNull();
  });

  it.each([
    ["missing", ""],
    ["mismatched", `&iss=${encodeURIComponent("http://evil")}`],
  ])("rejects access_denied with a %s iss — no dispatch", async (_label, issQuery) => {
    insertGuardian({ accountId: "OWNER" });
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildApps({ emails: ["invitee@example.com"] });

    const { state } = await start(app);
    const res = await app.request(
      `/api/auth/cloud/callback?state=${state}&error=access_denied${issQuery}`,
    );

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=iss");
    expect(sessionUserId(res)).toBeNull();
  });

  it("keeps the generic denied reason for other oauth errors", async () => {
    insertGuardian({ accountId: "OWNER" });
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildApps({ emails: ["invitee@example.com"] });

    const { state } = await start(app);
    const res = await app.request(
      `/api/auth/cloud/callback?state=${state}&error=server_error&iss=${ISS}`,
    );

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=denied");
    expect(sessionUserId(res)).toBeNull();
  });
});
