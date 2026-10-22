// GET /oauth/:provider/start for Shopify, which authorizes per store. Rome
// Cloud's Shopify install page sends the browser here with the store named once
// Shopify has installed the app. The route runs against the real start-redirect
// and redeem helpers and a test DB, so the asserted Rome Cloud URL and the
// pending attempt are the ones a live instance would produce. Only Rome Cloud's
// token endpoint and the custody side effects are faked.

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

const { syncProviderTokenFile } = rs.hoisted(() => ({
  syncProviderTokenFile: rs.fn(async (..._a: unknown[]) => {}),
}));

rs.mock("../../lib/provider-token-files.js", () => ({
  syncProviderTokenFile,
  clearProviderTokenFile: rs.fn(async (..._a: unknown[]) => {}),
}));
rs.mock("../../lib/github-shell-integration.js", () => ({
  syncGithubShellIntegrationForProvider: rs.fn(async (..._a: unknown[]) => {}),
  clearGithubShellIntegrationForProvider: rs.fn(async (..._a: unknown[]) => {}),
}));
rs.mock("../../lib/guardian-auth-state.js", () => ({
  getGuardianAuthState: rs.fn(async () => ({
    exists: true,
    userId: "guardian-1",
    onboardingComplete: true,
  })),
}));

import type { DrizzleDb } from "../../db/index.js";
import { oauthPendingAttempts } from "../../db/schema.js";
import { createTestDb } from "../../test/helpers.js";
import { COOKIE_NAME, createGuardianSession } from "../../lib/auth.js";
import { setInstanceTokenInMemory } from "../../lib/instance-identity.js";
import { SHOPIFY_INSTALL_URL } from "../../lib/oauth-providers.js";
import { DrizzleGrantLedger } from "../../connections/ledger-db.js";
import { ConnectionRegistry } from "../../connections/registry.js";
import { makeOAuthProviderDescriptor } from "../../connections/integrations/oauth-providers.js";
import type { ApiDeps } from "../deps.js";
import { oauthRoutes } from "./oauth.js";

const ROME_CLOUD = "https://rome-cloud.example";
const INSTANCE = "https://acme.rome.test";

describe("GET /oauth/shopify/start", () => {
  const savedEnv = { ...process.env };
  let db: DrizzleDb;
  let close: () => void;

  beforeEach(() => {
    process.env.PANTHEON_BASE_ORIGIN = ROME_CLOUD;
    process.env.PANTHEON_INSTANCE_ORIGIN = INSTANCE;
    delete process.env.ROME_LOOPBACK_CALLBACK_ORIGIN;
    ({ db, close } = createTestDb());
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    setInstanceTokenInMemory(null);
    rs.restoreAllMocks();
    close();
  });

  function start(query: string, opts: { signedIn: boolean }) {
    const app = new Hono().route("/", oauthRoutes({ db } as unknown as ApiDeps));
    const headers: Record<string, string> = {};
    if (opts.signedIn) {
      headers.cookie = `${COOKIE_NAME}=${createGuardianSession("guardian-1").token}`;
    }
    return app.request(`/oauth/shopify/start${query}`, { headers });
  }

  it("sends a signed-in guardian to Rome Cloud's Shopify authorize with the store", async () => {
    const res = await start("?shop=Acme.myshopify.com", { signedIn: true });

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      `${ROME_CLOUD}/connections/shopify/authorize`,
    );
    expect(location.searchParams.get("shop")).toBe("acme.myshopify.com");
    expect(location.searchParams.get("callbackOrigin")).toBe(INSTANCE);
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The instance owns the attempt: the state Rome Cloud echoes back is one it
    // minted, holding the PKCE verifier for the redeem.
    const attempts = await db.select().from(oauthPendingAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      provider: "shopify",
      state: location.searchParams.get("state"),
      callbackOrigin: INSTANCE,
    });
  });

  it("accepts the store's admin address and carries reconnect", async () => {
    const res = await start(
      `?shop=${encodeURIComponent("https://admin.shopify.com/store/acme")}&reconnect=1`,
      { signedIn: true },
    );

    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("shop")).toBe("acme.myshopify.com");
    expect(location.searchParams.get("reconnect")).toBe("1");
  });

  it("sends a signed-out browser to the Shopify card with the store, not to Rome Cloud", async () => {
    const res = await start("?shop=acme.myshopify.com", { signedIn: false });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/settings/connections/shopify?shop=acme.myshopify.com",
    );
    expect(await db.select().from(oauthPendingAttempts)).toHaveLength(0);
  });

  it("sends an invalid store to Shopify's install link without starting a connect", async () => {
    for (const shop of ["evil.example.com", "acme.myshopify.com.evil.example", "-acme"]) {
      const res = await start(`?shop=${encodeURIComponent(shop)}`, { signedIn: true });

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(SHOPIFY_INSTALL_URL);
    }
    expect(await db.select().from(oauthPendingAttempts)).toHaveLength(0);
  });

  it("sends a start with no store to Shopify's install link, where Shopify asks for one", async () => {
    for (const signedIn of [true, false]) {
      const res = await start("", { signedIn });

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        "https://admin.shopify.com/oauth/install?client_id=c7248430857716e104a01db512ed40ed",
      );
    }
    expect(await db.select().from(oauthPendingAttempts)).toHaveLength(0);
  });

  it("still refuses a POST start for Shopify", async () => {
    const app = new Hono().route("/", oauthRoutes({ db } as unknown as ApiDeps));
    const res = await app.request("/oauth/shopify/start?shop=acme.myshopify.com", {
      method: "POST",
      headers: { cookie: `${COOKIE_NAME}=${createGuardianSession("guardian-1").token}` },
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(SHOPIFY_INSTALL_URL);
  });

  it("redeems a route-started connect into the Shopify grant and lands on the Shopify card", async () => {
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
    registry.register(makeOAuthProviderDescriptor("shopify"));
    const deps = {
      db,
      connectionRegistry: registry,
      loginUsage: { recordLogin: () => {} },
    } as unknown as ApiDeps;
    const app = new Hono().route("/", oauthRoutes(deps));
    const cookie = `${COOKIE_NAME}=${createGuardianSession("guardian-1").token}`;

    const started = await app.request("/oauth/shopify/start?shop=acme.myshopify.com", {
      headers: { cookie },
    });
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");

    // Rome Cloud answers the handoff with the bundle its Shopify adapter builds.
    setInstanceTokenInMemory("romeinst_test-token");
    const tokenRequests: Array<Record<string, unknown>> = [];
    rs.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      tokenRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          provider: "shopify",
          profile: {
            subject: "acme.myshopify.com",
            email: "owner@example.com",
            displayName: "Acme",
            login: "acme.myshopify.com",
          },
          tokens: {
            accessToken: "shpat_redeemed",
            refreshToken: "shprt_redeemed",
            scope: "read_products,write_products",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            raw: { shop: "acme.myshopify.com" },
          },
        }),
        { status: 200 },
      );
    });

    const redeemed = await app.request("/oauth/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handoff: "handoff-1", state }),
    });

    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toMatchObject({
      ok: true,
      provider: "shopify",
      nextPath: "/settings/connections/shopify",
    });
    // The redeem proved the attempt with the verifier the start minted.
    const [attempt] = await db.select().from(oauthPendingAttempts);
    expect(tokenRequests[0]?.code_verifier).toBe(attempt?.codeVerifier);
    expect(attempt?.consumedAt).toBeInstanceOf(Date);

    const conn = registry.find("shopify")[0];
    expect(conn?.auth.grants().store).toBe("authorized");
    const grant = await registry.getLedger().getGrant(conn!.id, "store");
    expect(grant?.profile).toMatchObject({
      login: "acme.myshopify.com",
      scopes: ["read_products", "write_products"],
    });
  });
});
