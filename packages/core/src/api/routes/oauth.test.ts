// The /oauth/redeem provider write path (github/google) and Slack proof guard.
//
// The grant ledger is now the SOLE OAuth store. Redeem makes one direct write:
// import the redeemed bundle into the provider's grant (credential + the
// service-parsed profile in one update). The grant transition drives the registry's
// custody hook, which materializes the tmpfs token file + gh/git shell auth —
// the route never touches those artifacts, and there is NO legacy
// `provider_accounts` write anymore. The import is fail-closed: a missing
// registry, or a bundle that yields no usable credential, or a ledger write that
// throws all fail the redeem so nothing reports connected.
//
// This test injects redemption and stubs custody side effects (so nothing hits
// the network, disk, or spawns `gh`) while driving a real ConnectionRegistry,
// so route imports exercise the real ledger transition path.

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

const { syncProviderTokenFile, syncGithubShellIntegrationForProvider } = rs.hoisted(() => ({
  syncProviderTokenFile: rs.fn(async (..._a: unknown[]) => {}),
  syncGithubShellIntegrationForProvider: rs.fn(async (..._a: unknown[]) => {}),
}));

rs.mock("../../lib/provider-token-files.js", () => ({
  syncProviderTokenFile,
  clearProviderTokenFile: rs.fn(async (..._a: unknown[]) => {}),
}));
rs.mock("../../lib/github-shell-integration.js", () => ({
  syncGithubShellIntegrationForProvider,
  clearGithubShellIntegrationForProvider: rs.fn(async (..._a: unknown[]) => {}),
}));
rs.mock("../../lib/oauth-providers.js", () => ({
  OAUTH_PROVIDERS: ["google", "github", "slack"],
  getEnabledOAuthProviders: () => ["github", "slack"],
  isEnabledOAuthProvider: () => true,
  OAUTH_PROVIDER_DESCRIPTORS: { github: { label: "GitHub", description: "" } },
}));

import { createTestDb } from "../../test/helpers.js";
import { DrizzleGrantLedger } from "../../connections/ledger-db.js";
import { ConnectionRegistry } from "../../connections/registry.js";
import { makeOAuthProviderDescriptor } from "../../connections/integrations/oauth-providers.js";
import type { ApiDeps } from "../deps.js";
import { oauthRoutes } from "./oauth.js";

const pendingRomeCloudOAuthProvider = rs.fn(async (): Promise<"slack" | null> => null);
const redeemRomeCloudOAuthHandoff = rs.fn();

// A fresh drizzle-backed ledger per test (InMemoryGrantLedger left with p1);
// opened DBs are closed after each test.
const openDbs: Array<() => void> = [];
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

function makeRegistry(): ConnectionRegistry {
  const registry = new ConnectionRegistry({ ledger: makeLedger() });
  for (const provider of ["github", "slack", "google"] as const) {
    registry.register(makeOAuthProviderDescriptor(provider));
  }
  return registry;
}

function makeDeps(registry?: ConnectionRegistry, slackIngressConfigured = false): ApiDeps {
  return {
    db: {},
    connectionRegistry: registry,
    slackIngress: { configured: slackIngressConfigured },
    oauthRedeemServices: {
      guardianState: async () => ({
        exists: true,
        userId: "guardian-1",
        onboardingComplete: true,
        accountId: null,
        hasLocalPassword: true,
      }),
      pendingProvider: pendingRomeCloudOAuthProvider,
      redeemHandoff: redeemRomeCloudOAuthHandoff,
    },
  } as unknown as ApiDeps;
}

async function postRedeem(deps: ApiDeps) {
  const app = new Hono().route("/", oauthRoutes(deps));
  const response = await app.request("/oauth/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handoff: "h", state: "s" }),
  });
  return response;
}

describe("POST /oauth/redeem — ledger-only provider write path", () => {
  beforeEach(() => {
    rs.clearAllMocks();
    pendingRomeCloudOAuthProvider.mockResolvedValue(null);
  });
  afterEach(() => {
    while (openDbs.length) openDbs.pop()?.();
  });

  it("github: writes the ledger only; grant authorized with profile; custody materializes off the transition", async () => {
    redeemRomeCloudOAuthHandoff.mockResolvedValueOnce({
      provider: "github",
      profile: { login: "octocat" },
      tokens: { accessToken: "gho_redeemed", scope: "repo,read:org" },
      metadata: null,
    });
    const registry = makeRegistry();

    const res = await postRedeem(makeDeps(registry));
    expect(res.status).toBe(200);
    // Ledger import happened — a github connection holds an authorized grant that
    // carries the non-secret conferral outcome (identity + scopes).
    const conn = registry.find("github")[0];
    expect(conn).toBeDefined();
    expect(conn.auth.grants().user).toBe("authorized");
    const grant = await registry.getLedger().getGrant(conn.id, "user");
    expect(grant?.profile).toMatchObject({ login: "octocat", scopes: ["repo", "read:org"] });
    // Only github was minted.
    expect(registry.find("slack")).toHaveLength(0);
    expect(registry.find("google")).toHaveLength(0);
  });

  it("slack: refuses the fallback path because it carries no guardian proof", async () => {
    pendingRomeCloudOAuthProvider.mockResolvedValueOnce("slack");
    const registry = makeRegistry();
    const deps = makeDeps(registry, true);

    const res = await postRedeem(deps);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error:
        "Reconnect Slack from Settings so Rome can verify the guardian before enabling bot conversations.",
    });
    expect(redeemRomeCloudOAuthHandoff).not.toHaveBeenCalled();
    expect(registry.find("slack")).toHaveLength(0);
    expect(registry.find("github")).toHaveLength(0);
  });

  it("slack: retains connector-only redeem when bot event ingress is not configured", async () => {
    pendingRomeCloudOAuthProvider.mockResolvedValueOnce("slack");
    redeemRomeCloudOAuthHandoff.mockResolvedValueOnce({
      provider: "slack",
      profile: { team_id: "T1", team_name: "Acme" },
      tokens: { accessToken: "xoxb-test" },
      metadata: null,
    });
    const registry = makeRegistry();

    const res = await postRedeem(makeDeps(registry));

    expect(res.status).toBe(200);
    expect(registry.find("slack")[0]?.auth.grants().workspace).toBe("authorized");
  });

  it("google: imports the expiring bundle into the user grant (env gating does not apply)", async () => {
    redeemRomeCloudOAuthHandoff.mockResolvedValueOnce({
      provider: "google",
      profile: "default",
      tokens: {
        accessToken: "ya29.redeemed",
        refreshToken: "1//refresh",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      metadata: null,
    });
    const registry = makeRegistry();

    const res = await postRedeem(makeDeps(registry));

    expect(res.status).toBe(200);
    const conn = registry.find("google")[0];
    expect(conn).toBeDefined();
    expect(conn.auth.grants().user).toBe("authorized");
  });

  it("fails the redeem when the ledger import throws — nothing reports connected", async () => {
    redeemRomeCloudOAuthHandoff.mockResolvedValueOnce({
      provider: "github",
      profile: { login: "octocat" },
      tokens: { accessToken: "gho_redeemed" },
      metadata: null,
    });
    const registry = makeRegistry();
    // Force the sole write to fail. The connection is minted first, so it exists —
    // but its grant must NOT reach authorized, and custody must never fire.
    rs.spyOn(registry, "importCredential").mockRejectedValueOnce(new Error("ledger down"));

    const res = await postRedeem(makeDeps(registry));

    expect(res.status).toBe(502);
    const conn = registry.find("github")[0];
    expect(conn?.auth.grants().user).not.toBe("authorized");
    expect(syncProviderTokenFile).not.toHaveBeenCalled();
    expect(syncGithubShellIntegrationForProvider).not.toHaveBeenCalled();
  });

  it("fails the redeem when the redeemed bundle carries no usable token", async () => {
    redeemRomeCloudOAuthHandoff.mockResolvedValueOnce({
      provider: "github",
      profile: { login: "octocat" },
      tokens: { accessToken: "   " },
      metadata: null,
    });
    const registry = makeRegistry();

    const res = await postRedeem(makeDeps(registry));

    expect(res.status).toBe(502);
    expect(registry.find("github")[0]?.auth.grants().user).not.toBe("authorized");
    expect(syncProviderTokenFile).not.toHaveBeenCalled();
  });

  it("fails the redeem when no registry is wired (ledger is the sole store)", async () => {
    redeemRomeCloudOAuthHandoff.mockResolvedValueOnce({
      provider: "github",
      profile: { login: "octocat" },
      tokens: { accessToken: "gho_redeemed" },
      metadata: null,
    });

    const res = await postRedeem(makeDeps(undefined));

    expect(res.status).toBe(502);
    // No store to write ⇒ nothing connected, and custody never runs.
    expect(syncProviderTokenFile).not.toHaveBeenCalled();
    expect(syncGithubShellIntegrationForProvider).not.toHaveBeenCalled();
  });
});
