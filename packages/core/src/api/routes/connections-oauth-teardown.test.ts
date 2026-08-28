// OAuth-provider teardown through the registry-native
// DELETE routes (superseding `POST /integrations/:provider/disconnect`).
//
// Tearing down a Rome Cloud-OAuth provider removes the legacy providerAccounts
// row AND revokes the grant-ledger credential (so the registry's connection
// state relocks). Dropping the legacy row matters: the boot reconciler
// re-imports a retained row over an unauthorized grant, so a ledger-only
// teardown would resurrect on the next boot. The route does not clear the tmpfs
// file / gh shell auth itself: the revoke transition drives the registry's
// custody hook, which clears them. The custody libs are faked so nothing hits
// the disk or spawns `gh`; a real ConnectionRegistry holding an authorized
// grant proves the revoke happens, its custody clear runs off the transition,
// and it is best-effort (a custody-clear failure does not block the teardown).

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as providerAccountsModule from "../../lib/provider-accounts.js" with {
  rstest: "importActual",
};

const {
  removeProviderAccount,
  syncProviderTokenFile,
  clearProviderTokenFile,
  syncGithubShellIntegrationForProvider,
  clearGithubShellIntegrationForProvider,
} = rs.hoisted(() => ({
  removeProviderAccount: rs.fn(async (..._a: unknown[]) => {}),
  syncProviderTokenFile: rs.fn(async (..._a: unknown[]) => {}),
  clearProviderTokenFile: rs.fn(async (..._a: unknown[]) => {}),
  syncGithubShellIntegrationForProvider: rs.fn(async (..._a: unknown[]) => {}),
  clearGithubShellIntegrationForProvider: rs.fn(async (..._a: unknown[]) => {}),
}));

// Spread the real module so any export the route path transitively depends on
// (e.g. `normalizeScopes` via the connections bundle mapper) resolves against
// the actual implementation; only the stateful calls below are stubbed.
rs.mock("../../lib/provider-accounts.js", () => ({
  ...providerAccountsModule,
  removeProviderAccount,
  getProviderTokenBundle: rs.fn(async () => null),
}));
// Both the sync and clear halves are stubbed: `makeAuthorizedRegistry` imports a
// bundle (→ custody sync fires) before the test tears down (→ custody clear).
rs.mock("../../lib/provider-token-files.js", () => ({
  syncProviderTokenFile,
  clearProviderTokenFile,
}));
rs.mock("../../lib/github-shell-integration.js", () => ({
  syncGithubShellIntegrationForProvider,
  clearGithubShellIntegrationForProvider,
}));
rs.mock("../../lib/oauth-providers.js", () => ({
  OAUTH_PROVIDERS: ["google", "github", "slack"],
  isOAuthProvider: (value: string) => ["google", "github", "slack"].includes(value),
  getEnabledOAuthProviders: () => ["github", "slack", "google"],
  isEnabledOAuthProvider: () => true,
}));

import { createTestDb } from "../../test/helpers.js";
import { DrizzleGrantLedger } from "../../connections/ledger-db.js";
import { ConnectionRegistry } from "../../connections/registry.js";
import { importProviderBundle } from "../../connections/providers-import.js";
import { makeOAuthProviderDescriptor } from "../../connections/integrations/oauth-providers.js";
import type { ApiDeps } from "../deps.js";
import { connectionsRoutes } from "./connections.js";

// A fresh drizzle-backed ledger per test; opened DBs are closed after each test.
const openDbs: Array<() => void> = [];
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

/** A registry with all three providers registered and `provider` authorized. */
async function makeAuthorizedRegistry(
  provider: "github" | "slack" | "google",
): Promise<ConnectionRegistry> {
  const registry = new ConnectionRegistry({ ledger: makeLedger() });
  for (const p of ["github", "slack", "google"] as const) {
    registry.register(makeOAuthProviderDescriptor(p));
  }
  const bundle =
    provider === "slack"
      ? { accessToken: "xoxb-live", raw: { authed_user: { access_token: "xoxp-live" } } }
      : { accessToken: "tok_live" };
  await importProviderBundle(registry, provider, bundle);
  return registry;
}

function request(deps: ApiDeps, path: string) {
  const app = new Hono().route("/", connectionsRoutes(deps));
  return app.request(path, {
    method: "DELETE",
    headers: { "sec-fetch-site": "same-origin" },
  });
}

describe("OAuth teardown via /connections DELETE routes", () => {
  beforeEach(() => {
    rs.clearAllMocks();
  });
  afterEach(() => {
    while (openDbs.length) openDbs.pop()?.();
  });

  it.each([
    ["github", "user"],
    ["slack", "workspace"],
    ["google", "user"],
  ] as const)("grant revoke removes the legacy row, relocks the %s grant, and custody clears off the transition", async (provider, grant) => {
    const registry = await makeAuthorizedRegistry(provider);
    const conn = registry.find(provider)[0];
    expect(conn.auth.grants()[grant]).toBe("authorized");
    clearProviderTokenFile.mockClear();
    clearGithubShellIntegrationForProvider.mockClear();

    const res = await request(
      { db: {}, connectionRegistry: registry } as unknown as ApiDeps,
      `/connections/${conn.id}/grants/${grant}`,
    );

    expect(res.status).toBe(200);
    // Legacy row removed.
    expect(removeProviderAccount).toHaveBeenCalledTimes(1);
    // Ledger grant relocked.
    expect(registry.find(provider)[0].auth.grants()[grant]).toBe("unauthorized");
    // Custody cleared off the revoke transition (not the route directly).
    expect(clearProviderTokenFile).toHaveBeenCalledWith(provider);
    expect(clearGithubShellIntegrationForProvider).toHaveBeenCalledWith(provider);
  });

  it("connection removal also drops the legacy row", async () => {
    const registry = await makeAuthorizedRegistry("github");
    const conn = registry.find("github")[0];

    const res = await request(
      { db: {}, connectionRegistry: registry } as unknown as ApiDeps,
      `/connections/${conn.id}`,
    );

    expect(res.status).toBe(200);
    expect(removeProviderAccount).toHaveBeenCalledTimes(1);
    expect(registry.find("github")).toHaveLength(0);
  });

  it("still 200s when the custody clear rejects (revoke completes first)", async () => {
    clearProviderTokenFile.mockRejectedValueOnce(new Error("tmpfs gone"));
    const registry = await makeAuthorizedRegistry("github");
    const conn = registry.find("github")[0];

    const res = await request(
      { db: {}, connectionRegistry: registry } as unknown as ApiDeps,
      `/connections/${conn.id}/grants/user`,
    );

    expect(res.status).toBe(200);
    // The revoke wrote the ledger before firing custody, so the grant relocked
    // despite the custody-clear failure (which the registry swallows).
    expect(registry.find("github")[0].auth.grants().user).toBe("unauthorized");
  });
});
