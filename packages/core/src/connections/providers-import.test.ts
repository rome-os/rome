// Provider OAuth bundle → grant ledger imports (github/slack/
// google): the credential mapper and the shared connection import.
//
// Covers:
//   credentialFromBundle:
//     github/google — flat { accessToken, refreshToken?, expiresAt? }; expiry
//       maps to a Date (google's tokens DO expire) or "never"; null on no token
//     slack — { botToken, userToken? } (user token extracted from
//       raw.authed_user.access_token; optional), null on no bot token
//   importProviderBundle: mints a connection + imports on first call, reuses on
//     re-import (idempotent no-op), no-ops when the descriptor isn't registered
//     or the bundle carries no token

import { afterEach, describe, expect, it, rs } from "@rstest/core";

// The real OAuth descriptor's custody hook (added/5c) writes the tmpfs
// token file + spawns `gh` off every authorized/revoke transition. These tests
// exercise the ledger-import logic, not custody, so stub both custody libs to
// keep them off the real disk / `gh` binary (which would clobber a developer's
// real gh auth on revoke). Custody firing itself is covered in
// registry-lifecycle.test.ts.
rs.mock("../lib/github-shell-integration.js", () => ({
  syncGithubShellIntegrationForProvider: rs.fn(async () => {}),
  clearGithubShellIntegrationForProvider: rs.fn(async () => {}),
}));
rs.mock("../lib/provider-token-files.js", () => ({
  syncProviderTokenFile: rs.fn(async () => {}),
  clearProviderTokenFile: rs.fn(async () => {}),
}));

import { createTestDb } from "../test/helpers.js";
import type { DrizzleDb } from "../db/index.js";
import type { OAuthProvider } from "../lib/oauth-providers.js";
import type { OAuthTokenBundle } from "../lib/provider-accounts.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import {
  credentialFromBundle,
  grantProfileFromBundle,
  importProviderBundle,
} from "./providers-import.js";
import {
  OAUTH_PROVIDER_GRANTS,
  makeOAuthProviderDescriptor,
} from "./integrations/oauth-providers.js";

// A fresh drizzle-backed ledger per test (InMemoryGrantLedger left with p1);
// the ledger shares each test's db (distinct tables), closed after each test.
const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});
function freshDb(): DrizzleDb {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return db;
}

/** A registry declaring every provider in `providers` over the test db's ledger. */
function makeRegistry(
  db: DrizzleDb,
  providers: OAuthProvider[] = ["github", "slack", "google"],
): ConnectionRegistry {
  const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
  for (const provider of providers) registry.register(makeOAuthProviderDescriptor(provider));
  return registry;
}

describe("credentialFromBundle", () => {
  it("github: flattens accessToken into a non-expiring credential when no expiry", () => {
    const cred = credentialFromBundle("github", { accessToken: "gho_x" });
    expect(cred).toEqual({ material: { accessToken: "gho_x" }, expiresAt: "never" });
  });

  it("google: carries refreshToken + expiresAt, and maps the expiry to a Date", () => {
    const cred = credentialFromBundle("google", {
      accessToken: "ya29.x",
      refreshToken: "1//r",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(cred?.material).toEqual({
      accessToken: "ya29.x",
      refreshToken: "1//r",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(cred?.expiresAt).toBeInstanceOf(Date);
    expect((cred?.expiresAt as Date).toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("slack: extracts { botToken, userToken } from the bundle + raw authed_user", () => {
    const cred = credentialFromBundle("slack", {
      accessToken: "xoxb-bot",
      raw: { authed_user: { access_token: "xoxp-user" }, team: { id: "T1" } },
    });
    expect(cred).toEqual({
      material: { botToken: "xoxb-bot", userToken: "xoxp-user" },
      expiresAt: "never",
    });
  });

  it("slack: userToken is optional — a bot-only install still yields a credential", () => {
    const cred = credentialFromBundle("slack", { accessToken: "xoxb-bot" });
    expect(cred).toEqual({ material: { botToken: "xoxb-bot" }, expiresAt: "never" });
    // A malformed raw payload is ignored, not crashed on.
    const malformed = credentialFromBundle("slack", {
      accessToken: "xoxb-bot",
      raw: { authed_user: { access_token: 42 } },
    });
    expect(malformed?.material).toEqual({ botToken: "xoxb-bot" });
  });

  it("returns null when the bundle carries no usable token (all providers)", () => {
    for (const provider of ["github", "slack", "google"] as const) {
      expect(credentialFromBundle(provider, {})).toBeNull();
      expect(credentialFromBundle(provider, { accessToken: "   " })).toBeNull();
      expect(credentialFromBundle(provider, { accessToken: null })).toBeNull();
    }
  });
});

describe("grantProfileFromBundle", () => {
  it("github: identity fields + scopes, no teamId", () => {
    const profile = grantProfileFromBundle(
      "github",
      { accessToken: "gho", scope: ["repo", "read:user"] },
      {
        subject: "42",
        login: "octocat",
        displayName: "Octo Cat",
        email: "o@example.com",
        avatarUrl: "https://a/o.png",
      },
    );
    expect(profile).toEqual({
      subject: "42",
      login: "octocat",
      displayName: "Octo Cat",
      email: "o@example.com",
      avatarUrl: "https://a/o.png",
      scopes: ["repo", "read:user"],
    });
    expect("teamId" in profile).toBe(false);
  });

  it("slack: teamId is classified as profile (workspace identity), not credential material", () => {
    const bundle: OAuthTokenBundle = {
      accessToken: "xoxb-bot",
      scope: ["chat:write"],
      raw: { authed_user: { access_token: "xoxp-user" }, team: { id: "T123" } },
    };
    const profile = grantProfileFromBundle("slack", bundle, { displayName: "Ada" });
    expect(profile).toEqual({ displayName: "Ada", scopes: ["chat:write"], teamId: "T123" });
    // The workspace identity lands on the PROFILE, never inside the secret material.
    expect(credentialFromBundle("slack", bundle)?.material).toEqual({
      botToken: "xoxb-bot",
      userToken: "xoxp-user",
    });
  });

  it("omits empty identity fields and empty scopes — sparse but typed", () => {
    expect(grantProfileFromBundle("github", { accessToken: "gho" }, {})).toEqual({});
    expect(
      grantProfileFromBundle("github", { accessToken: "gho" }, { login: "", email: null }),
    ).toEqual({});
  });

  it("carries only the OAuth profile keys — no handoff metadata bag reaches the ledger", () => {
    const profile = grantProfileFromBundle(
      "google",
      { accessToken: "ya29", scope: ["email"] },
      { email: "u@g.com" },
    );
    expect(Object.keys(profile).sort()).toEqual(["email", "scopes"]);
  });

  it("rejects a raw payload whose values fail the service schema — nothing is coerced", () => {
    expect(() => grantProfileFromBundle("github", { accessToken: "gho" }, { login: 42 })).toThrow();
    expect(() =>
      grantProfileFromBundle("google", { accessToken: "ya29" }, { displayName: ["a"] }),
    ).toThrow();
  });

  it("rejects a Slack team id that is not a string — never silently dropped", () => {
    expect(() =>
      grantProfileFromBundle(
        "slack",
        { accessToken: "xoxb", raw: { team: { id: 123 } } },
        { displayName: "Ada" },
      ),
    ).toThrow();
  });
});

describe("a malformed conferral fails loudly and stores nothing", () => {
  it("importProviderBundle rejects and the grant keeps no credential or profile", async () => {
    const registry = makeRegistry(freshDb());
    await expect(
      importProviderBundle(registry, "github", { accessToken: "gho" }, { login: 42 }),
    ).rejects.toThrow();
    const rec = await grantProfile(registry, "github");
    expect(rec?.credential).toBeUndefined();
    expect(rec?.profile).toBeUndefined();
  });
});

async function grantProfile(registry: ConnectionRegistry, provider: OAuthProvider) {
  const conn = registry.find(provider)[0];
  const rec = await registry.getLedger().getGrant(conn.id, OAUTH_PROVIDER_GRANTS[provider]);
  return rec;
}

describe("importProviderBundle records the conferral profile", () => {
  it("writes the typed profile on the grant in the same import as the credential", async () => {
    const registry = makeRegistry(freshDb());
    await importProviderBundle(
      registry,
      "slack",
      {
        accessToken: "xoxb-bot",
        scope: ["chat:write"],
        raw: { authed_user: { access_token: "xoxp-user" }, team: { id: "T9" } },
      },
      { login: "ada", email: "ada@example.com" },
    );
    const rec = await grantProfile(registry, "slack");
    expect(rec?.state).toBe("authorized");
    expect(rec?.profile).toEqual({
      login: "ada",
      email: "ada@example.com",
      scopes: ["chat:write"],
      teamId: "T9",
    });
  });

  it("records no profile on the boot path (no account supplied)", async () => {
    const registry = makeRegistry(freshDb());
    await importProviderBundle(registry, "github", { accessToken: "gho" });
    const rec = await grantProfile(registry, "github");
    expect(rec?.state).toBe("authorized");
    expect(rec?.profile).toBeUndefined();
  });

  it("re-conferral replaces both the profile and the credential", async () => {
    const registry = makeRegistry(freshDb());
    await importProviderBundle(
      registry,
      "github",
      { accessToken: "gho_1", scope: ["repo"] },
      { login: "old" },
    );
    await importProviderBundle(
      registry,
      "github",
      { accessToken: "gho_2", scope: ["repo", "gist"] },
      { login: "new", email: "new@example.com" },
    );
    const rec = await grantProfile(registry, "github");
    expect(rec?.profile).toEqual({
      login: "new",
      email: "new@example.com",
      scopes: ["repo", "gist"],
    });
    expect(rec?.credential?.material).toEqual({ kind: "inline", record: { accessToken: "gho_2" } });
  });

  it("refreshes the profile on re-conferral even when the token is byte-identical", async () => {
    const registry = makeRegistry(freshDb());
    // Same access token both times, but the identity changed (renamed login,
    // broader scopes) — the profile must still land, or the grant keeps a stale one.
    await importProviderBundle(
      registry,
      "github",
      { accessToken: "gho_same", scope: ["repo"] },
      { login: "before" },
    );
    await importProviderBundle(
      registry,
      "github",
      { accessToken: "gho_same", scope: ["repo", "gist"] },
      { login: "after", email: "after@example.com" },
    );
    const rec = await grantProfile(registry, "github");
    expect(rec?.profile).toEqual({
      login: "after",
      email: "after@example.com",
      scopes: ["repo", "gist"],
    });
  });

  it("keeps the profile of the conferral that degraded — no wipe on degrade", async () => {
    const db = freshDb();
    const registry = makeRegistry(db);
    // A google token that has already expired, conferred with an identity.
    await importProviderBundle(
      registry,
      "google",
      {
        accessToken: "ya29.stale",
        scope: ["email"],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      { displayName: "u", email: "u@g.com" },
    );
    // Boot: load() renews-once (romeCloudOAuth answers "re-confer") → the grant degrades.
    const registry2 = makeRegistry(db);
    await registry2.load();
    expect(registry2.find("google")[0].auth.grants().user).toBe("degraded");
    // The degrade wrote state + reason only — the profile is untouched.
    const rec = await grantProfile(registry2, "google");
    expect(rec?.profile).toEqual({ displayName: "u", email: "u@g.com", scopes: ["email"] });
  });

  it("revoke clears the profile — an unauthorized grant records no conferral outcome", async () => {
    const registry = makeRegistry(freshDb());
    await importProviderBundle(registry, "github", { accessToken: "gho" }, { login: "octo" });
    const conn = registry.find("github")[0];
    await conn.auth.revoke("user");
    const rec = await grantProfile(registry, "github");
    expect(rec?.state).toBe("unauthorized");
    expect(rec?.profile).toBeUndefined();
  });
});

const BUNDLES: Array<[OAuthProvider, string, OAuthTokenBundle]> = [
  ["github", "user", { accessToken: "gho_a" }],
  ["google", "user", { accessToken: "ya29.a", refreshToken: "1//r" }],
  [
    "slack",
    "workspace",
    { accessToken: "xoxb-a", raw: { authed_user: { access_token: "xoxp-a" } } },
  ],
];

describe.each(BUNDLES)("importProviderBundle [%s]", (provider, grant, bundle) => {
  it("mints a connection and imports the grant on first call", async () => {
    const registry = makeRegistry(freshDb());
    expect(registry.find(provider)).toHaveLength(0);

    const imported = await importProviderBundle(registry, provider, bundle);
    expect(imported).toBe(true);

    const conn = registry.find(provider)[0];
    expect(conn).toBeDefined();
    expect(conn.auth.grants()[grant]).toBe("authorized");
  });

  it("reuses the existing connection on re-import (idempotent — no duplicate)", async () => {
    const registry = makeRegistry(freshDb());
    await importProviderBundle(registry, provider, bundle);
    await importProviderBundle(registry, provider, bundle);
    expect(registry.find(provider)).toHaveLength(1);
    expect(registry.find(provider)[0].auth.grants()[grant]).toBe("authorized");
  });

  it("no-ops when the bundle carries no token", async () => {
    const registry = makeRegistry(freshDb());
    const imported = await importProviderBundle(registry, provider, {});
    expect(imported).toBe(false);
    expect(registry.find(provider)).toHaveLength(0);
  });

  it("no-ops when the provider's descriptor isn't registered", async () => {
    const registry = makeRegistry(freshDb(), []);
    const imported = await importProviderBundle(registry, provider, bundle);
    expect(imported).toBe(false);
  });
});
