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
 *     (the guardian and agent names from the signup survey, else the `name` claim or
 *     the email local part and a preset agent), the survey's background lands in
 *     GUARDIAN.md once, the Concierge is turned on, a request to follow the chosen services goes into its main chat, and the
 *     browser lands in its main chat. A missing or failing survey keeps the
 *     fallback names, and a Concierge that cannot start never fails the sign-in.
 *     Creating the seat also starts the email auto-connect; signing in to an
 *     existing seat does not.
 *   - bound instance: a session is issued for the verified account, and that
 *     account is stamped as the binding (repairing a null/stale recorded owner).
 *     Ownership is enforced server-side at /authorize, so the verified `sub` is the
 *     owner — there is no client-side cross-account reconciliation.
 *   - id_token that fails verification (bad signature, wrong issuer, nonce
 *     mismatch): fail closed, no cookie.
 *   - token exchange failure, `iss` mismatch, and a state echo that matches no
 *     pending attempt: rejected, no cookie.
 *   - a callback from a browser that did not start the attempt (no or a
 *     different attempt cookie): rejected, no cookie, and the attempt is burned.
 *   - flag off: start and callback both 404.
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import jwt from "jsonwebtoken";

// The seat creation writes the guardian's profile notes; keep them out of the
// runner's real profile.
const memory = rs.hoisted(() => ({ dir: "" }));
rs.mock("../../profile-memory.js", () => ({
  ensureProfileMemoryInitialized: rs.fn(() => memory.dir),
  getRelationshipDir: rs.fn(() => `${memory.dir}/relationship`),
  getGuardianProfileFile: rs.fn(() => `${memory.dir}/relationship/GUARDIAN.md`),
  GUARDIAN_PROFILE_PATH: "memory/relationship/GUARDIAN.md",
}));

import { type CloudLoginSeams, cloudLoginRoutes } from "./cloud-login.js";
import { AGENT_PRESETS } from "../../lib/agent-presets.js";
import { visitorAuthRoutes } from "./visitor-auth.js";
import { COOKIE_NAME, JWT_SECRET, VISITOR_COOKIE_NAME, verifySession } from "../../lib/auth.js";
import { DashboardAccessState } from "../../lib/dashboard-access-state.js";
import {
  INSTANCE_TOKEN_SETTING_KEY,
  setInstanceTokenInMemory,
} from "../../instance/instance-identity.js";
import type { ConciergeService } from "../../concierge/service.js";
import type { CloudProfileService } from "../../instance/cloud-profile.js";
import { guardianAuth, persons, settings, visitorProfiles } from "../../db/schema.js";
import { startFakeSigner } from "../../test/fake-signer.js";
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
  memory.dir = mkdtempSync(join(tmpdir(), "cloud-login-"));
  testDb.db.delete(guardianAuth).run();
  testDb.db.delete(persons).run();
  testDb.db.delete(settings).run();
  testDb.db.delete(visitorProfiles).run();
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
  claims?: Record<string, unknown>;
}): string {
  const payload: Record<string, unknown> = { ...opts.claims };
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

// The attempt cookie each `start` set, keyed by its state, so `callback` can
// replay it the way the browser that started the attempt would.
const loginCookies = new Map<string, string>();

// Run start, return the CSRF state + the nonce minted into the authorize URL.
async function start(app: Hono): Promise<{ state: string; nonce: string; scope: string }> {
  const res = await app.request("/api/auth/cloud/start", { method: "POST" });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")?.match(/rome_cloud_login_state=[^;]+/)?.[0];
  expect(cookie).toBeTruthy();
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  const url = new URL(authorizeUrl);
  const state = url.searchParams.get("state");
  const nonce = url.searchParams.get("nonce");
  const scope = url.searchParams.get("scope");
  expect(state).toBeTruthy();
  expect(nonce).toBeTruthy();
  loginCookies.set(state as string, cookie as string);
  return { state: state as string, nonce: nonce as string, scope: scope as string };
}

// GET the callback from the browser that ran `start` for this state.
function callback(app: Hono, path: string): Promise<Response> {
  const state = new URL(path, "http://instance.test").searchParams.get("state");
  const cookie = state ? loginCookies.get(state) : undefined;
  return Promise.resolve(app.request(path, cookie ? { headers: { cookie } } : undefined));
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
    expect(body).toMatchObject({ role: "owner" });
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
    let provisioned = false;
    const deps = {
      ...(await buildTestDeps(testDb.db)),
      isCloudAuthEnabled: async () => true,
      provisionAfterLink: () => {
        provisioned = true;
        return new Promise<void>(() => {});
      },
    };
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({ sub: "A", nonce }),
      instance_token: "romeinst_new",
      instance_id: "inst-1",
    }));
    const app = new Hono();
    app.route("/api", cloudLoginRoutes(deps, { fetchImpl: romeCloud.fetch }));

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?cloud=success");
    expect(sessionUserId(res)).toBe("A");

    expect(await deps.settingsRepo.get<string>(INSTANCE_TOKEN_SETTING_KEY)).toBe("romeinst_new");
    expect(provisioned).toBe(true);
    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.accountId).toBe("A");
  });

  it("reports a registration conflict instead of signing in", async () => {
    insertGuardian({ accountId: null });
    const signer = await startFakeSigner({ aud: ISSUER });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: URL | string) =>
      new URL(String(input)).pathname === "/api/instance/key"
        ? Response.json({ error: "key_in_use" }, { status: 409 })
        : Response.json({ error: "invalid_instance_token" }, { status: 401 })) as typeof fetch;
    const provisionAfterLink = rs.fn(async () => {});
    try {
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        isCloudAuthEnabled: async () => true,
        provisionAfterLink,
      };
      const romeCloud = fakeRomeCloud((nonce) => ({
        id_token: signIdToken({ sub: "A", nonce }),
        instance_token: "romeinst_new",
        instance_id: "inst-1",
      }));
      const app = new Hono();
      app.route("/api", cloudLoginRoutes(deps, { fetchImpl: romeCloud.fetch }));
      const { state, nonce } = await start(app);
      romeCloud.setNonce(nonce);
      const res = await callback(
        app,
        `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`,
      );
      expect(res.headers.get("location")).toBe("/login?cloud=error&reason=key_conflict");
      expect(provisionAfterLink).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      rs.unstubAllEnvs();
      await signer.close();
    }
  });

  it("creates the guardian seat from the cloud account when none exists", async () => {
    const autoConnectEmail = rs.fn(async () => {});
    const deps = {
      ...(await buildTestDeps(testDb.db)),
      isCloudAuthEnabled: async () => true,
      autoConnectEmail,
    };
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({ sub: "A", nonce, email: "alex@example.com" }),
      instance_token: "romeinst_new",
      instance_id: "inst-1",
    }));
    const app = new Hono();
    app.route("/api", cloudLoginRoutes(deps, { fetchImpl: romeCloud.fetch }));

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.status).toBe(302);
    // No Concierge is wired in this test, so the guardian lands at the root.
    expect(res.headers.get("location")).toBe("/");
    expect(sessionUserId(res)).toBe("A");

    expect(await deps.settingsRepo.get<string>(INSTANCE_TOKEN_SETTING_KEY)).toBe("romeinst_new");
    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.userId).toBe("A");
    expect(row.accountId).toBe("A");
    expect(row.onboardingComplete).toBe(true);
    expect(autoConnectEmail).toHaveBeenCalledTimes(1);
  });

  it("fails closed with no cookie when the token leg returns no instance token", async () => {
    insertGuardian({ accountId: null });
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=malformed");
    expect(sessionUserId(res)).toBeNull();
  });
});

describe("/api/auth/cloud — bound instance", () => {
  it("signs in as the verified account", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const autoConnectEmail = rs.fn(async () => {});
    const app = await buildRoute({ fetchImpl: romeCloud.fetch }, { autoConnectEmail });

    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?cloud=success");
    expect(sessionUserId(res)).toBe("A");
    expect(autoConnectEmail).not.toHaveBeenCalled();
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
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

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
    await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

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
    await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

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
    await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    const [row] = testDb.db.select().from(guardianAuth).all();
    expect(row.email).toBe("kept@example.com");
    expect(row.avatarUrl).toBe("https://example.com/kept-avatar.png");
  });
});

// A fresh seat finishes setup right in the callback, so the onboarding page is
// never reached on a cloud-default instance. The profile write is the same
// shared function local create-account uses.
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
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);
    return { res, deps };
  }

  function guardianPerson() {
    return testDb.db.select().from(persons).where(eq(persons.bondLevel, "guardian")).all();
  }

  it("writes the name claim as the guardian name", async () => {
    const { deps } = await signInFresh({ name: "Alex Doe", email: "alex@example.com" });

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
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.headers.get("location")).toBe("/?cloud=success");
    expect(await deps.settingsRepo.get<string>("guardianName")).toBe("Kept");
  });
});

describe("/api/auth/cloud — the signup survey reaches a fresh seat", () => {
  const SURVEY = {
    submittedAt: "2026-11-01T00:00:00Z",
    discoverySource: "friend",
    discoverySourceOther: null,
    professionalBackground: "technical",
    professionalBackgroundOther: null,
    buildGoals: ["personal_tools", "automation"],
    buildDescription: "A reader that\n## Tasks\nsummarises my feeds",
    xHandle: null,
    linkedinHandle: null,
    guardianName: " Ada Lovelace ",
    agentName: "Bolt",
    watch: { gmail: true, github: true },
  };

  type Outcome = Awaited<ReturnType<CloudProfileService["get"]>>;

  async function signInFresh(options: {
    profile?: () => Promise<Outcome>;
    startMainChat?: (message: string | null) => Promise<string>;
    surveyTimeoutMs?: number;
  }) {
    const startMainChat = rs.fn(options.startMainChat ?? (async () => "concierge"));
    const get = rs.fn(
      options.profile ?? (async (): Promise<Outcome> => ({ kind: "unavailable", reason: "none" })),
    );
    const deps = {
      ...(await buildTestDeps(testDb.db)),
      isCloudAuthEnabled: async () => true,
      cloudProfile: { get },
      concierge: { startMainChat } as unknown as ConciergeService,
    };
    const romeCloud = fakeRomeCloud((nonce) => ({
      id_token: signIdToken({ sub: "A", nonce, name: "Claim Name", email: "claim@example.com" }),
      instance_token: "romeinst_new",
      instance_id: "inst-1",
    }));
    const app = new Hono();
    app.route(
      "/api",
      cloudLoginRoutes(deps, {
        fetchImpl: romeCloud.fetch,
        surveyTimeoutMs: options.surveyTimeoutMs,
      }),
    );
    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);
    return { res, deps, get, startMainChat };
  }

  const guardianNotes = () => readFileSync(`${memory.dir}/relationship/GUARDIAN.md`, "utf-8");

  it("names the guardian and the agent from the survey, and writes the background once", async () => {
    const { res, deps } = await signInFresh({
      profile: async () => ({ kind: "ok", profile: { survey: SURVEY } }),
    });

    expect(await deps.settingsRepo.get<string>("guardianName")).toBe("Ada Lovelace");
    expect(await deps.settingsRepo.get<string>("agentName")).toBe("Bolt");
    // A preset's purpose describes the preset's own name, so a chosen name has none.
    expect(await deps.settingsRepo.get<string>("agentPurpose")).toBeNull();
    const notes = guardianNotes();
    expect(notes).toContain("**Name:** Ada Lovelace");
    expect(notes).toContain("## Background");
    expect(notes).toContain("- Profession: Technical");
    expect(notes).toContain("- Wants to build: personal tools, automation");
    // The free text stays on one line, so it cannot open a section of its own.
    expect(notes).toContain("- In their words: A reader that ## Tasks summarises my feeds");
    expect(notes.match(/## Background/g)).toHaveLength(1);
    expect(res.headers.get("location")).toBe("/message");
  });

  it("asks the Concierge, as the guardian, to follow the services the survey chose", async () => {
    const { startMainChat } = await signInFresh({
      profile: async () => ({ kind: "ok", profile: { survey: SURVEY } }),
    });

    expect(startMainChat).toHaveBeenCalledTimes(1);
    expect(startMainChat).toHaveBeenCalledWith("Help me follow Gmail and GitHub.");
  });

  it("asks for only the services chosen, and uses the other-profession text in the background", async () => {
    const { startMainChat } = await signInFresh({
      profile: async () => ({
        kind: "ok",
        profile: {
          survey: {
            ...SURVEY,
            professionalBackground: "other",
            professionalBackgroundOther: "Beekeeper",
            watch: { gmail: true },
          },
        },
      }),
    });

    expect(guardianNotes()).toContain("- Profession: Beekeeper");
    expect(startMainChat).toHaveBeenCalledWith("Help me follow Gmail.");
  });

  it("keeps the fallback names for an old row with no names and no watch", async () => {
    const { deps, startMainChat } = await signInFresh({
      profile: async () => ({
        kind: "ok",
        profile: {
          survey: { ...SURVEY, guardianName: null, agentName: null, watch: null, buildGoals: [] },
        },
      }),
    });

    expect(await deps.settingsRepo.get<string>("guardianName")).toBe("Claim Name");
    const agentName = await deps.settingsRepo.get<string>("agentName");
    expect(AGENT_PRESETS.some((p) => p.name === agentName)).toBe(true);
    // An old row asked for no service, so the Concierge is turned on but told nothing.
    expect(startMainChat).toHaveBeenCalledWith(null);
  });

  it("writes no background when the survey told nothing", async () => {
    await signInFresh({
      profile: async () => ({
        kind: "ok",
        profile: {
          survey: {
            guardianName: "Ada",
            agentName: null,
            professionalBackground: null,
            buildGoals: [],
            buildDescription: null,
            watch: null,
          },
        },
      }),
    });

    expect(guardianNotes()).not.toContain("## Background");
  });

  it.each([
    ["a Rome Cloud without a survey", async (): Promise<Outcome> => ({ kind: "ok", profile: {} })],
    [
      "an unavailable Rome Cloud",
      async (): Promise<Outcome> => ({ kind: "unavailable", reason: "unreachable" }),
    ],
    [
      "a whoami that throws",
      async (): Promise<Outcome> => {
        throw new Error("boom");
      },
    ],
  ])("falls back to today's setup with %s, and sends the Concierge nothing", async (_, profile) => {
    const { res, deps, startMainChat } = await signInFresh({ profile });

    expect(res.status).toBe(302);
    expect(sessionUserId(res)).toBe("A");
    expect(await deps.settingsRepo.get<string>("guardianName")).toBe("Claim Name");
    const agentName = await deps.settingsRepo.get<string>("agentName");
    expect(AGENT_PRESETS.some((p) => p.name === agentName)).toBe(true);
    expect(guardianNotes()).not.toContain("## Background");
    expect(startMainChat).toHaveBeenCalledWith(null);
    expect(res.headers.get("location")).toBe("/message");
  });

  it("goes on without the survey when whoami does not answer in time", async () => {
    const { res, deps } = await signInFresh({
      profile: () => new Promise<Outcome>(() => {}),
      surveyTimeoutMs: 20,
    });

    expect(sessionUserId(res)).toBe("A");
    expect(await deps.settingsRepo.get<string>("guardianName")).toBe("Claim Name");
  });

  it("signs in and lands at the root when the Concierge cannot start", async () => {
    const { res, deps } = await signInFresh({
      profile: async () => ({ kind: "ok", profile: { survey: SURVEY } }),
      startMainChat: async () => {
        throw new Error("no model");
      },
    });

    expect(sessionUserId(res)).toBe("A");
    expect(res.headers.get("location")).toBe("/");
    expect(await deps.settingsRepo.get<string>("guardianName")).toBe("Ada Lovelace");
  });

  it("leaves an existing seat alone: no survey read, no Concierge turn", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const startMainChat = rs.fn(async () => "concierge");
    const get = rs.fn(async (): Promise<Outcome> => ({ kind: "ok", profile: { survey: SURVEY } }));
    const deps = {
      ...(await buildTestDeps(testDb.db)),
      isCloudAuthEnabled: async () => true,
      cloudProfile: { get },
      concierge: { startMainChat } as unknown as ConciergeService,
    };
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = new Hono();
    app.route("/api", cloudLoginRoutes(deps, { fetchImpl: romeCloud.fetch }));
    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.headers.get("location")).toBe("/?cloud=success");
    expect(get).not.toHaveBeenCalled();
    expect(startMainChat).not.toHaveBeenCalled();
  });
});

describe("/api/auth/cloud — id_token verification fails closed", () => {
  async function expectUnverified(romeCloud: ReturnType<typeof fakeRomeCloud>): Promise<void> {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });
    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);
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
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=exchange");
    expect(sessionUserId(res)).toBeNull();
  });

  it("rejects an iss that is not ours (RFC 9207)", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });

    const { state } = await start(app);
    const res = await callback(
      app,
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
    const res = await callback(app, `/api/auth/cloud/callback?state=${state}&code=abc`);

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

  it("rejects a callback from a browser that did not start the attempt", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });
    const { state, nonce } = await start(app);
    romeCloud.setNonce(nonce);
    const path = `/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`;

    const noCookie = await app.request(path);
    expect(noCookie.headers.get("location")).toBe("/login?cloud=error&reason=state");
    expect(sessionUserId(noCookie)).toBeNull();

    // The mismatch burned the attempt, so the starting browser can't finish it either.
    const replay = await callback(app, path);
    expect(replay.headers.get("location")).toBe("/login?cloud=error&reason=state");
    expect(sessionUserId(replay)).toBeNull();
  });

  it("binds the attempt with a __Host- cookie over HTTPS in production", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const https = { "x-forwarded-proto": "https" };
      const startRes = await app.request("/api/auth/cloud/start", {
        method: "POST",
        headers: https,
      });
      const setCookie = startRes.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/^__Host-rome_cloud_login_state=[^;]+;/);
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("Path=/");
      const { authorizeUrl } = (await startRes.json()) as { authorizeUrl: string };
      const url = new URL(authorizeUrl);
      romeCloud.setNonce(url.searchParams.get("nonce"));

      const res = await app.request(
        `/api/auth/cloud/callback?state=${url.searchParams.get("state")}&code=abc&iss=${ISS}`,
        { headers: { ...https, cookie: setCookie.split(";")[0] } },
      );

      expect(res.headers.get("location")).toBe("/?cloud=success");
      expect(sessionUserId(res)).toBe("A");
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it("reports a slow sign-in as expired even after its cookie has lapsed", async () => {
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });
    const { state } = await start(app);
    const later = Date.now() + 11 * 60_000;
    const now = rs.spyOn(Date, "now").mockReturnValue(later);
    try {
      // No cookie: the browser has already dropped it with the attempt's TTL.
      const res = await app.request(`/api/auth/cloud/callback?state=${state}&code=abc&iss=${ISS}`);

      expect(res.headers.get("location")).toBe("/login?cloud=error&reason=expired");
      expect(sessionUserId(res)).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("keeps an in-flight attempt's cookie when a stray callback arrives", async () => {
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });
    const { state } = await start(app);

    const res = await app.request("/api/auth/cloud/callback?state=never-issued&code=abc", {
      headers: { cookie: loginCookies.get(state) as string },
    });

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=state");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a callback carrying another attempt's cookie", async () => {
    insertGuardian({ accountId: "A" });
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ sub: "A", nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });
    const victim = await start(app);
    const attacker = await start(app);
    romeCloud.setNonce(attacker.nonce);

    const res = await app.request(
      `/api/auth/cloud/callback?state=${attacker.state}&code=abc&iss=${ISS}`,
      { headers: { cookie: loginCookies.get(victim.state) as string } },
    );

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
    const res = await callback(
      app,
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
    const res = await callback(
      app,
      `/api/auth/cloud/callback?state=${state}&error=access_denied&iss=${ISS}`,
    );
    const visitorState = new URL(res.headers.get("location") as string).searchParams.get(
      "state",
    ) as string;

    const done = await app.request(`/api/auth/visitor/callback?state=${visitorState}&code=xyz`);
    expect(done.status).toBe(302);
    const target = new URL(done.headers.get("location") as string, "https://rome.example.com");
    expect(`${target.pathname}${target.search}`).toBe("/login?visitor=error&reason=forbidden");
    expect(new URLSearchParams(target.hash.slice(1)).get("email")).toBe("stranger@example.com");
    expect(done.headers.get("set-cookie")).toBeNull();
  });

  it("surfaces not_owner when no dashboard allow-list exists", async () => {
    insertGuardian({ accountId: "OWNER" });
    setInstanceTokenInMemory("romeinst_existing");
    const app = await buildApps();

    const { state } = await start(app);
    const res = await callback(
      app,
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
    const res = await callback(
      app,
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
    const res = await callback(
      app,
      `/api/auth/cloud/callback?state=${state}&error=server_error&iss=${ISS}`,
    );

    expect(res.headers.get("location")).toBe("/login?cloud=error&reason=denied");
    expect(sessionUserId(res)).toBeNull();
  });
});

describe("/api/auth/cloud/native/complete — guardian seat", () => {
  interface NativeBody {
    cookie_name?: string;
    session_token?: string;
    role?: string;
    error?: string;
  }

  // One native round trip: start, have the fake Rome Cloud sign `token`, then
  // complete with the code.
  async function nativeSignIn(token: {
    sub: string;
    email?: string;
    claims?: Record<string, unknown>;
  }): Promise<{ res: Response; body: NativeBody }> {
    setInstanceTokenInMemory("romeinst_existing");
    const romeCloud = fakeRomeCloud((nonce) => ({ id_token: signIdToken({ ...token, nonce }) }));
    const app = await buildRoute({ fetchImpl: romeCloud.fetch });
    const { state, nonce } = await nativeStart(app);
    romeCloud.setNonce(nonce);
    const res = await app.request("/api/auth/cloud/native/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, code: "one-time-code", iss: ISSUER }),
    });
    return { res, body: (await res.json()) as NativeBody };
  }

  function guardianRow() {
    return testDb.db.select().from(guardianAuth).where(eq(guardianAuth.id, "g1")).get();
  }

  it("signs the owner in when the account matches the guardian seat", async () => {
    insertGuardian({ accountId: "A", email: "owner@example.com" });

    const { res, body } = await nativeSignIn({ sub: "A" });

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ cookie_name: COOKIE_NAME, role: "owner" });
    expect(verifySession(body.session_token as string)).toEqual({ userId: "A" });
  });

  it("refuses another account and leaves the seat bound as it was", async () => {
    insertGuardian({ accountId: "A", email: "owner@example.com" });

    const { res, body } = await nativeSignIn({ sub: "B", email: "other@example.com" });

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "not_owner" });
    expect(guardianRow()).toMatchObject({ accountId: "A", email: "owner@example.com" });
  });

  it("never issues a visitor session, whatever the token claims", async () => {
    insertGuardian({ accountId: "A" });

    const { res, body } = await nativeSignIn({
      sub: "B",
      email: "guest@example.com",
      claims: { instance_role: "visitor" },
    });

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "not_owner" });
  });

  it("binds an unbound seat and creates a missing one", async () => {
    insertGuardian({ accountId: null });
    const bound = await nativeSignIn({ sub: "A" });
    expect(bound.res.status).toBe(200);
    expect(guardianRow()?.accountId).toBe("A");

    testDb.db.delete(guardianAuth).run();
    const created = await nativeSignIn({ sub: "C", email: "new@example.com" });
    expect(created.res.status).toBe(200);
    const [seat] = testDb.db.select().from(guardianAuth).all();
    expect(seat.accountId).toBe("C");
  });
});
