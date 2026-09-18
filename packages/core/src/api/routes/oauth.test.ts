// The /oauth/redeem provider write path (github/slack/google).
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
// This test fakes the redemption + the custody libs (so nothing hits the
// network, disk, or spawns `gh`) and drives a real ConnectionRegistry, so the
// ledger import AND the transition-driven custody sync are exercised for real.

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as providerAccountsModule from "../../lib/provider-accounts.js" with {
  rstest: "importActual",
};

const {
  redeemRomeCloudOAuthHandoff,
  syncProviderTokenFile,
  syncGithubShellIntegrationForProvider,
} = rs.hoisted(() => ({
  redeemRomeCloudOAuthHandoff: rs.fn(),
  syncProviderTokenFile: rs.fn(async (..._a: unknown[]) => {}),
  syncGithubShellIntegrationForProvider: rs.fn(async (..._a: unknown[]) => {}),
}));

rs.mock("../../lib/rome-cloud-oauth.js", () => ({
  redeemRomeCloudOAuthHandoff,
  createRomeCloudOAuthStartRedirect: rs.fn(),
  createRomeCloudOAuthStartUrl: rs.fn(() => ({ connectUrl: "", available: true })),
}));
// Spread the real module so exports the route path relies on transitively
// (e.g. `normalizeScopes`, consumed by the connections bundle mapper) resolve
// against the actual implementation; only the network/disk side effects below
// are stubbed.
rs.mock("../../lib/provider-accounts.js", () => ({
  ...providerAccountsModule,
  getProviderTokenBundle: rs.fn(async () => null),
}));
rs.mock("../../lib/provider-token-files.js", () => ({
  syncProviderTokenFile,
  clearProviderTokenFile: rs.fn(async (..._a: unknown[]) => {}),
}));
rs.mock("../../lib/github-shell-integration.js", () => ({
  syncGithubShellIntegrationForProvider,
  clearGithubShellIntegrationForProvider: rs.fn(async (..._a: unknown[]) => {}),
}));
rs.mock("../../lib/guardian-auth-state.js", () => ({
  getGuardianAuthState: rs.fn(async () => ({
    exists: true,
    userId: "guardian-1",
    onboardingComplete: true,
  })),
}));
rs.mock("../../lib/auth.js", () => ({
  COOKIE_NAME: "rome_session",
  verifySession: rs.fn(() => null),
  issueGuardianSession: rs.fn(),
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

function makeDeps(registry?: ConnectionRegistry): ApiDeps {
  return { db: {}, connectionRegistry: registry } as unknown as ApiDeps;
}

async function postRedeem(deps: ApiDeps) {
  const app = new Hono().route("/", oauthRoutes(deps));
  return app.request("/oauth/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handoff: "h", state: "s" }),
  });
}

describe("POST /oauth/redeem — ledger-only provider write path", () => {
  beforeEach(() => {
    rs.clearAllMocks();
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
    // Custody ran off the grant transition (not the route), driven by the grant's
    // secret material + non-secret profile.
    expect(syncProviderTokenFile).toHaveBeenCalledWith(
      "github",
      { accessToken: "gho_redeemed" },
      { login: "octocat", scopes: ["repo", "read:org"] },
    );
    expect(syncGithubShellIntegrationForProvider).toHaveBeenCalledWith("github", {
      accessToken: "gho_redeemed",
    });
    // Only github was minted.
    expect(registry.find("slack")).toHaveLength(0);
    expect(registry.find("google")).toHaveLength(0);
  });

  it("slack: imports the two-token bundle into the workspace grant", async () => {
    redeemRomeCloudOAuthHandoff.mockResolvedValueOnce({
      provider: "slack",
      profile: "default",
      tokens: {
        accessToken: "xoxb-redeemed",
        raw: { authed_user: { access_token: "xoxp-redeemed" }, team: { id: "T123" } },
      },
      metadata: null,
    });
    const registry = makeRegistry();

    const res = await postRedeem(makeDeps(registry));

    expect(res.status).toBe(200);
    const conn = registry.find("slack")[0];
    expect(conn).toBeDefined();
    expect(conn.auth.grants().workspace).toBe("authorized");
    const grant = await registry.getLedger().getGrant(conn.id, "workspace");
    expect(grant?.profile).toMatchObject({ teamId: "T123" });
    expect(registry.find("github")).toHaveLength(0);
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
