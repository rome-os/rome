// The Rome Cloud-OAuth connection-state descriptors (github/slack/
// google/shopify), exercised over a REAL ConnectionRegistry + drizzle grant ledger. This
// phase migrates ONLY the connection state (no Actor/Watcher — capabilities are
// deliberately empty), so the contracts under test are:
//
//   1. Shape: one grant per provider (github/google `user`, slack `workspace`,
//      shopify `store`),
//      no capabilities (act/talk/watch all unsupported).
//   2. Grant lifecycle: import → authorized; revoke → unauthorized.
//   3. Boot rehydration: a fresh registry over the same ledger rehydrates the
//      authorized grant on load().
//   4. romeCloudOAuth at-load renew: an EXPIRED credential (google's and
//      shopify's tokens do expire) renews via the scheme. With no refresh wired
//      it answers "re-confer" and the grant degrades until the guardian
//      reconnects; with a refresh wired (shopify) the grant renews.
//   5. Shopify's setup asks which store to connect before the redirect, and an
//      expiring grant renews ahead of expiry.

import { afterEach, describe, expect, it, rs } from "@rstest/core";

// The descriptor's custody hook writes the tmpfs token file + spawns `gh` off
// every authorized/revoke transition. These tests exercise grant state, not
// custody, so stub both custody libs to keep them off the real disk / `gh`
// binary (which would clobber a developer's real gh auth on revoke). Custody
// firing itself is covered in registry-lifecycle.test.ts.
rs.mock("../../lib/github-shell-integration.js", () => ({
  syncGithubShellIntegrationForProvider: rs.fn(async () => {}),
  clearGithubShellIntegrationForProvider: rs.fn(async () => {}),
}));
rs.mock("../../lib/provider-token-files.js", () => ({
  syncProviderTokenFile: rs.fn(async () => {}),
  clearProviderTokenFile: rs.fn(async () => {}),
}));

import type { OAuthProvider } from "../../lib/oauth-providers.js";
import { createTestDb } from "../../test/helpers.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import type { GrantLedger } from "../ledger.js";
import { ConnectionRegistry } from "../registry.js";
import { RenewalUnavailable } from "../errors.js";
import type { SetupContext, SetupForm, SetupInteraction } from "../setup/types.js";
import type { Credential } from "../types.js";
import {
  OAUTH_PROVIDER_GRANTS,
  makeOAuthProviderDescriptor,
  makeOAuthProviderSetup,
} from "./oauth-providers.js";

function credential(material: Record<string, string>): Credential {
  return { material, expiresAt: "never" };
}

// A fresh drizzle-backed ledger per test (InMemoryGrantLedger left with p1);
// opened DBs are closed after each test.
const openDbs: Array<() => void> = [];
function makeLedger(): GrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

const CASES: Array<[OAuthProvider, string, Record<string, string>]> = [
  ["github", "user", { accessToken: "gho_live" }],
  ["google", "user", { accessToken: "ya29.live", refreshToken: "1//refresh" }],
  ["slack", "workspace", { botToken: "xoxb-live", userToken: "xoxp-live" }],
  ["shopify", "store", { accessToken: "shpat_live", refreshToken: "shprt_live" }],
];

describe("OAuth profile revival", () => {
  it("revives GitHub's stored schema: login is the handle, committer identity fields survive", () => {
    const revive = makeOAuthProviderDescriptor("github").reviveProfile;
    expect(revive).toBeDefined();
    const display = revive?.("user", {
      subject: "12345",
      login: "octocat",
      displayName: "The Octocat",
      email: "octo@example.com",
      avatarUrl: "https://example.com/octo.png",
      scopes: ["repo", "read:user"],
    });
    expect(display?.displayName).toBe("The Octocat");
    expect(display?.handle).toBe("octocat");
    expect(display?.email).toBe("octo@example.com");
    expect(display?.avatarUrl).toBe("https://example.com/octo.png");
    // subject/scopes are owner-side profile data, not display surface.
    expect(display && Object.keys(display)).not.toContain("subject");
  });

  it("revives Slack's stored schema: workspace name is the handle; teamId stays off the display", () => {
    const revive = makeOAuthProviderDescriptor("slack").reviveProfile;
    const display = revive?.("workspace", {
      subject: "T123:U456",
      login: "Acme Corp",
      displayName: "Ada Lovelace",
      teamId: "T123",
      scopes: ["chat:write"],
    });
    expect(display?.displayName).toBe("Ada Lovelace");
    expect(display?.handle).toBe("Acme Corp");
    // teamId is workspace identity for the token-file custody, not a display field.
    expect(display && Object.keys(display)).not.toContain("teamId");
  });

  it("revives Google's stored schema: OIDC identity with no handle", () => {
    const revive = makeOAuthProviderDescriptor("google").reviveProfile;
    const display = revive?.("user", {
      subject: "sub-789",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: "https://example.com/ada.png",
    });
    expect(display?.displayName).toBe("Ada Lovelace");
    expect(display?.email).toBe("ada@example.com");
    expect(display?.avatarUrl).toBe("https://example.com/ada.png");
    expect(display?.handle).toBeUndefined();
  });

  it.each(CASES)("keeps a sparse but valid %s profile sparse", (provider, grant) => {
    const revive = makeOAuthProviderDescriptor(provider).reviveProfile;
    const display = revive?.(grant, { email: "ada@example.com" });
    expect(display?.email).toBe("ada@example.com");
    expect(display?.displayName).toBeUndefined();
    expect(display?.handle).toBeUndefined();
    expect(display?.avatarUrl).toBeUndefined();

    const empty = revive?.(grant, {});
    expect(empty?.displayName).toBeUndefined();
    expect(empty?.handle).toBeUndefined();
  });

  it.each(
    CASES,
  )("rejects reviving a %s record whose values no longer match the schema — never a silently sparse display", (provider, grant) => {
    const revive = makeOAuthProviderDescriptor(provider).reviveProfile;
    expect(() => revive?.(grant, { displayName: 42 })).toThrow();
    expect(() => revive?.(grant, { email: "" })).toThrow();
  });

  it("revives Shopify's stored schema: the myshopify.com domain is the handle", () => {
    const revive = makeOAuthProviderDescriptor("shopify").reviveProfile;
    const display = revive?.("store", {
      subject: "acme.myshopify.com",
      login: "acme.myshopify.com",
      displayName: "Acme Goods",
      email: "owner@example.com",
      scopes: ["read_products"],
    });
    expect(display?.displayName).toBe("Acme Goods");
    expect(display?.handle).toBe("acme.myshopify.com");
    expect(display?.email).toBe("owner@example.com");
    expect(display?.avatarUrl).toBeUndefined();
    // A store has no avatar: the schema refuses one.
    expect(() => revive?.("store", { avatarUrl: "https://example.com/a.png" })).toThrow();
  });

  it("rejects reviving a stored record carrying keys outside the service's schema", () => {
    const github = makeOAuthProviderDescriptor("github").reviveProfile;
    expect(() => github?.("user", { login: "octocat", teamId: "T123" })).toThrow();
    // `login` is a GitHub/Slack key; Google's schema deliberately has no handle.
    const google = makeOAuthProviderDescriptor("google").reviveProfile;
    expect(() => google?.("user", { login: "octocat" })).toThrow();
  });
});

describe.each(
  CASES,
)("OAuth connection-state descriptor [%s, drizzle ledger]", (provider, grant, material) => {
  afterEach(() => {
    rs.restoreAllMocks();
    while (openDbs.length) openDbs.pop()?.();
  });

  it(`declares one \`${grant}\` grant and no capabilities (state-only phase)`, async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeOAuthProviderDescriptor(provider));
    const conn = await registry.connect(provider);

    expect(conn.service).toBe(provider);
    expect(conn.auth.grants()).toEqual({ [grant]: "unauthorized" });
    // No Actor in this phase — connector_proxy keeps its legacy token path.
    expect(conn.act).toBeNull();
    expect(conn.isUnlocked("talk")).toBe(false);
    expect(conn.watch).toBeNull();
    expect(conn.status()).toEqual({
      talk: { state: "unsupported" },
      act: { state: "unsupported" },
      watch: { state: "unsupported" },
    });
  });

  it("attaches the conferral setup to the grant only when setup deps are given", () => {
    // State-only descriptor (no setup deps): no conferral setup.
    expect(makeOAuthProviderDescriptor(provider).auth[grant].setup).toBeUndefined();
    // Wired descriptor (#1611): the grant carries a setup coroutine.
    const wired = makeOAuthProviderDescriptor(provider, {
      beginRedirect: async () => "https://broker/authorize?state=s",
      redeem: async () => ({ credential: { material: { accessToken: "t" }, expiresAt: "never" } }),
    });
    expect(typeof wired.auth[grant].setup).toBe("function");
  });

  it("authorizes the grant on import and relocks it on revoke", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeOAuthProviderDescriptor(provider));
    const conn = await registry.connect(provider);

    await registry.importCredential(conn.id, grant, credential(material));
    expect(conn.auth.grants()[grant]).toBe("authorized");

    await conn.auth.revoke(grant);
    expect(conn.auth.grants()[grant]).toBe("unauthorized");
  });

  it("rehydrates the authorized grant on a fresh registry over the same ledger", async () => {
    const ledger = makeLedger();

    const registry = new ConnectionRegistry({ ledger });
    registry.register(makeOAuthProviderDescriptor(provider));
    const conn = await registry.connect(provider);
    await registry.importCredential(conn.id, grant, credential(material));

    // Second registry over the SAME ledger: boot rehydration restores the grant.
    const registry2 = new ConnectionRegistry({ ledger });
    registry2.register(makeOAuthProviderDescriptor(provider));
    await registry2.load();

    const rehydrated = registry2.find(provider)[0];
    expect(rehydrated).toBeDefined();
    expect(rehydrated.auth.grants()[grant]).toBe("authorized");
  });

  it("degrades an EXPIRED credential at load: romeCloudOAuth renew answers re-confer", async () => {
    const ledger = makeLedger();

    const registry = new ConnectionRegistry({ ledger });
    registry.register(makeOAuthProviderDescriptor(provider));
    const conn = await registry.connect(provider);
    // A bundle that carried an explicit expiry, now past (google's tokens
    // always do; github/slack only if the provider ever sends one).
    await registry.importCredential(conn.id, grant, {
      material,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(conn.auth.grants()[grant]).toBe("authorized");

    // Boot: load() sees the expired credential, renews once via the scheme —
    // romeCloudOAuth has no refresh exchange, so renew() answers "re-confer"
    // and the grant degrades until the guardian re-runs the OAuth flow.
    const registry2 = new ConnectionRegistry({ ledger });
    registry2.register(makeOAuthProviderDescriptor(provider));
    await registry2.load();

    expect(registry2.find(provider)[0].auth.grants()[grant]).toBe("degraded");
  });
});

describe("OAUTH_PROVIDER_GRANTS", () => {
  it("matches the grant table (slack's two tokens live in ONE workspace grant)", () => {
    expect(OAUTH_PROVIDER_GRANTS).toEqual({
      github: "user",
      google: "user",
      slack: "workspace",
      shopify: "store",
    });
  });
});

describe("OAuth conferral setup", () => {
  const ctx: SetupContext = {
    step: (_label, fn) => fn(new AbortController().signal),
    signal: new AbortController().signal,
  };

  function scriptedInteraction(answers: string[]) {
    const prompts: Array<SetupForm & { error?: string }> = [];
    const interact: SetupInteraction = {
      prompt: async (form) => {
        prompts.push(form);
        return { shop: answers.shift() ?? "" };
      },
      show: () => {},
      redirect: async () => ({ handoff: "handoff-code", state: "state-1" }),
    };
    return { interact, prompts };
  }

  function deps() {
    const beginRedirect = rs.fn(async (_opts?: { shop?: string }) => "https://broker/authorize");
    return {
      beginRedirect,
      redeem: async () => ({
        credential: { material: { accessToken: "t" }, expiresAt: "never" as const },
      }),
    };
  }

  it("asks for the Shopify store, re-asks on a bad answer, and names it on the redirect", async () => {
    const d = deps();
    const { interact, prompts } = scriptedInteraction(["acme.com", "https://Acme.myshopify.com/"]);

    await makeOAuthProviderSetup("shopify", d)(interact, ctx);

    expect(prompts).toHaveLength(2);
    expect(prompts[0].error).toBeUndefined();
    expect(prompts[1].error).toMatch(/myshopify\.com/);
    expect(d.beginRedirect).toHaveBeenCalledWith({ shop: "acme.myshopify.com" });
  });

  it("goes straight to the redirect for a provider that isn't per store", async () => {
    const d = deps();
    const { interact, prompts } = scriptedInteraction([]);

    await makeOAuthProviderSetup("github", d)(interact, ctx);

    expect(prompts).toHaveLength(0);
    expect(d.beginRedirect).toHaveBeenCalledWith(undefined);
  });
});

describe("expiring OAuth grant renewal [shopify, drizzle ledger]", () => {
  afterEach(() => {
    rs.restoreAllMocks();
    while (openDbs.length) openDbs.pop()?.();
  });

  const setupDeps = (refresh: (refreshToken: string) => Promise<Credential>) => ({
    beginRedirect: async () => "https://broker/authorize",
    redeem: async () => ({ credential: credential({ accessToken: "t" }) }),
    refresh,
  });

  function renewed(): Credential {
    return {
      material: { accessToken: "shpat_new", refreshToken: "shprt_new" },
      expiresAt: new Date(Date.now() + 60 * 60_000),
    };
  }

  async function connectedRegistry(
    ledger: GrantLedger,
    refresh: (refreshToken: string) => Promise<Credential>,
    expiresInMs: number,
  ) {
    const registry = new ConnectionRegistry({ ledger });
    registry.register(makeOAuthProviderDescriptor("shopify", setupDeps(refresh)));
    const conn = await registry.connect("shopify");
    await registry.importCredential(conn.id, "store", {
      material: { accessToken: "shpat_old", refreshToken: "shprt_old" },
      expiresAt: new Date(Date.now() + expiresInMs),
    });
    return { registry, conn };
  }

  async function storedAccessToken(ledger: GrantLedger, connectionId: string) {
    const record = await ledger.getGrant(connectionId, "store");
    const material = record?.credential?.material;
    return material?.kind === "inline" ? material.record.accessToken : undefined;
  }

  it("renews an expired grant at load through the refresh", async () => {
    const ledger = makeLedger();
    const refresh = rs.fn(async () => renewed());
    const { conn } = await connectedRegistry(ledger, refresh, -60_000);

    const registry2 = new ConnectionRegistry({ ledger });
    registry2.register(makeOAuthProviderDescriptor("shopify", setupDeps(refresh)));
    await registry2.load();

    expect(refresh).toHaveBeenCalledWith("shprt_old");
    expect(registry2.find("shopify")[0].auth.grants().store).toBe("authorized");
    expect(await storedAccessToken(ledger, conn.id)).toBe("shpat_new");
  });

  it("renews a grant that expires within the window, and leaves a later one alone", async () => {
    const ledger = makeLedger();
    const refresh = rs.fn(async () => renewed());
    const { registry, conn } = await connectedRegistry(ledger, refresh, 5 * 60_000);

    await registry.renewExpiring(60_000);
    expect(refresh).not.toHaveBeenCalled();

    await registry.renewExpiring(10 * 60_000);
    expect(refresh).toHaveBeenCalledWith("shprt_old");
    expect(conn.auth.grants().store).toBe("authorized");
    expect(await storedAccessToken(ledger, conn.id)).toBe("shpat_new");
  });

  it("keeps a still-valid grant when an early refresh fails, so the next pass can retry", async () => {
    const ledger = makeLedger();
    const refresh = rs.fn(async (): Promise<Credential> => {
      throw new Error("Rome Cloud unavailable");
    });
    const { registry, conn } = await connectedRegistry(ledger, refresh, 5 * 60_000);

    await registry.renewExpiring(10 * 60_000);

    expect(refresh).toHaveBeenCalled();
    expect(conn.auth.grants().store).toBe("authorized");
    expect(await storedAccessToken(ledger, conn.id)).toBe("shpat_old");
  });

  it("keeps an expired grant when Rome Cloud can't answer, and renews it on a later pass", async () => {
    const ledger = makeLedger();
    const refresh = rs.fn(async (): Promise<Credential> => {
      throw new RenewalUnavailable("Rome Cloud OAuth refresh did not complete.");
    });
    const { registry, conn } = await connectedRegistry(ledger, refresh, -1_000);

    await registry.renewExpiring(10 * 60_000);
    expect(conn.auth.grants().store).toBe("authorized");

    refresh.mockImplementation(async () => renewed());
    await registry.renewExpiring(10 * 60_000);
    expect(conn.auth.grants().store).toBe("authorized");
    expect(await storedAccessToken(ledger, conn.id)).toBe("shpat_new");
  });

  it("recovers an expired grant once Rome Cloud accepts the instance again", async () => {
    // A 401 from Rome Cloud rejects the instance, not the Shopify grant, so the
    // refresh reports it as unavailable and the grant must survive until the
    // instance authenticates again.
    const ledger = makeLedger();
    const refresh = rs.fn(async (): Promise<Credential> => {
      throw new RenewalUnavailable("invalid_token");
    });
    const { registry, conn } = await connectedRegistry(ledger, refresh, -1_000);

    await registry.renewExpiring(10 * 60_000);
    await registry.renewExpiring(10 * 60_000);
    expect(conn.auth.grants().store).toBe("authorized");

    refresh.mockImplementation(async () => renewed());
    await registry.renewExpiring(10 * 60_000);
    expect(await storedAccessToken(ledger, conn.id)).toBe("shpat_new");
  });

  it("keeps an expired grant at boot when Rome Cloud can't answer", async () => {
    const ledger = makeLedger();
    const unavailable = rs.fn(async (): Promise<Credential> => {
      throw new RenewalUnavailable("Rome Cloud OAuth refresh did not complete.");
    });
    await connectedRegistry(ledger, unavailable, -60_000);

    const registry2 = new ConnectionRegistry({ ledger });
    registry2.register(makeOAuthProviderDescriptor("shopify", setupDeps(unavailable)));
    await registry2.load();

    expect(registry2.find("shopify")[0].auth.grants().store).toBe("authorized");
  });

  it("never lets a renewal in flight overwrite a reconnect that lands meanwhile", async () => {
    const ledger = makeLedger();
    let finishRefresh!: () => void;
    const refresh = rs.fn(
      () =>
        new Promise<Credential>((resolve) => {
          finishRefresh = () => resolve(renewed());
        }),
    );
    const { registry, conn } = await connectedRegistry(ledger, refresh, 5 * 60_000);

    // The renewal holds the grant while Rome Cloud is slow to answer...
    const renewal = registry.renewExpiring(10 * 60_000);
    await rs.waitFor(() => expect(refresh).toHaveBeenCalled());
    // ...and the guardian reconnects in the meantime.
    const reconnect = registry.confer(
      "shopify",
      conn.id,
      "store",
      {
        material: { accessToken: "shpat_reconnected", refreshToken: "shprt_reconnected" },
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
      undefined,
    );
    finishRefresh();
    await Promise.all([renewal, reconnect]);

    expect(await storedAccessToken(ledger, conn.id)).toBe("shpat_reconnected");
  });

  it("degrades a grant that has already expired when the refresh fails", async () => {
    const ledger = makeLedger();
    const refresh = rs.fn(async (): Promise<Credential> => {
      throw new Error("refresh token revoked");
    });
    const { registry, conn } = await connectedRegistry(ledger, refresh, -1_000);

    await registry.renewExpiring(10 * 60_000);

    expect(conn.auth.grants().store).toBe("degraded");
  });
});
