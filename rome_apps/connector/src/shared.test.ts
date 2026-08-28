import { describe, expect, it } from "@rstest/core";

import type { ComposioClient } from "./api/composio-client.js";
import {
  buildProxyEndpoint,
  isSupportedToolkit,
  SUPPORTED_TOOLKITS,
  subscribeTriggerFeed,
  TOOLKIT_API_HOSTS,
  TOOLKIT_DEFAULT_API_HOST,
  validateProxyEndpoint,
} from "./shared.js";
import { CATALOG } from "./web/lib/connections.js";

/**
 * SUPPORTED_TOOLKITS is the server-side twin of the web catalog. A connect
 * brokered for a toolkit the catalog doesn't list has no managed auth config and
 * no name/scope for its card, so the two must never drift. This pins them equal:
 * add a catalog entry and this fails until the twin is updated too.
 */
describe("SUPPORTED_TOOLKITS mirrors the web catalog", () => {
  it("contains exactly the catalog slugs", () => {
    expect([...SUPPORTED_TOOLKITS].sort()).toEqual(CATALOG.map((e) => e.slug).sort());
  });

  it("recognizes a catalog toolkit case-insensitively and rejects one outside it", () => {
    expect(isSupportedToolkit("Slack")).toBe(true);
    expect(isSupportedToolkit("twitter")).toBe(false);
  });
});

/**
 * `connector_proxy` forwards the connection's live OAuth credential to the
 * caller-supplied endpoint, so the host allowlist is the gate that stops the
 * token leaking off-provider. Every supported toolkit must have an entry (else
 * its proxy fails open to "no allowlist → reject everything", silently breaking
 * the toolkit), and the validator's rejection table is the security contract.
 */
describe("connector_proxy endpoint validation", () => {
  it("has an API-host allowlist entry for every supported toolkit", () => {
    expect(Object.keys(TOOLKIT_API_HOSTS).sort()).toEqual([...SUPPORTED_TOOLKITS].sort());
  });

  it("accepts an https endpoint on the toolkit's own domain (and subdomains)", () => {
    expect(validateProxyEndpoint("linear", "https://api.linear.app/graphql")).toBeNull();
    expect(
      validateProxyEndpoint("gmail", "https://gmail.googleapis.com/gmail/v1/users/me/profile"),
    ).toBeNull();
    expect(
      validateProxyEndpoint(
        "googleslides",
        "https://slides.googleapis.com/v1/presentations/presentation-id",
      ),
    ).toBeNull();
    expect(
      validateProxyEndpoint(
        "googleads",
        "https://googleads.googleapis.com/v18/customers:listAccessibleCustomers",
      ),
    ).toBeNull();
    expect(validateProxyEndpoint("metaads", "https://graph.facebook.com/v20.0/me")).toBeNull();
    expect(validateProxyEndpoint("supabase", "https://abcdef.supabase.co/rest/v1/x")).toBeNull();
  });

  it("rejects an off-provider host (credential exfiltration)", () => {
    expect(validateProxyEndpoint("linear", "https://evil.example.com/graphql")).toMatchObject({
      code: "host_not_allowed",
    });
  });

  it("rejects a non-https scheme", () => {
    expect(validateProxyEndpoint("linear", "http://api.linear.app/graphql")).toMatchObject({
      code: "insecure_scheme",
    });
  });

  it("rejects a userinfo trick whose real host is off-provider", () => {
    // new URL("https://api.linear.app@evil.com/").hostname === "evil.com"
    expect(
      validateProxyEndpoint("linear", "https://api.linear.app@evil.com/graphql"),
    ).toMatchObject({ code: "host_not_allowed" });
  });

  it("rejects a subdomain-suffix spoof of the provider domain", () => {
    expect(
      validateProxyEndpoint("linear", "https://api.linear.app.evil.com/graphql"),
    ).toMatchObject({ code: "host_not_allowed" });
  });

  it("rejects a non-URL endpoint", () => {
    expect(validateProxyEndpoint("linear", "not a url")).toMatchObject({ code: "invalid_url" });
  });

  it("rejects a toolkit with no allowlist entry", () => {
    expect(validateProxyEndpoint("twitter", "https://api.twitter.com/2/x")).toMatchObject({
      code: "unsupported_toolkit",
    });
  });
});

/**
 * `buildProxyEndpoint` assembles the absolute endpoint from a relative `path` +
 * optional `host` so the agent supplies only a path for single-host toolkits. It
 * is NOT the security gate — the action still runs the assembled URL through
 * `validateProxyEndpoint` — but its default host must always clear that gate, and
 * its rejections (full URL as path, missing host for a per-connection toolkit)
 * are the contract the action inherits.
 */
describe("connector_proxy path/host assembly", () => {
  it("fills in the toolkit's default host when host is omitted", () => {
    expect(buildProxyEndpoint("gmail", "/gmail/v1/users/me/profile")).toEqual({
      ok: true,
      endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    });
    expect(buildProxyEndpoint("slack", "/api/chat.postMessage")).toEqual({
      ok: true,
      endpoint: "https://slack.com/api/chat.postMessage",
    });
  });

  it("resolves the toolkit case-insensitively", () => {
    expect(buildProxyEndpoint("Gmail", "/x")).toEqual({
      ok: true,
      endpoint: "https://gmail.googleapis.com/x",
    });
  });

  it("uses an explicit host override and strips any scheme/trailing slash on it", () => {
    expect(
      buildProxyEndpoint("github", "/repos/o/r/releases/1/assets", "uploads.github.com"),
    ).toEqual({ ok: true, endpoint: "https://uploads.github.com/repos/o/r/releases/1/assets" });
    expect(
      buildProxyEndpoint("dropbox", "/2/files/download", "https://content.dropboxapi.com/"),
    ).toEqual({ ok: true, endpoint: "https://content.dropboxapi.com/2/files/download" });
  });

  it("requires an explicit host for a per-connection toolkit (no default)", () => {
    const rejected = buildProxyEndpoint("supabase", "/rest/v1/orders");
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.message).toMatch(/host/);
    expect(buildProxyEndpoint("supabase", "/rest/v1/orders", "abcd1234.supabase.co")).toEqual({
      ok: true,
      endpoint: "https://abcd1234.supabase.co/rest/v1/orders",
    });
  });

  it("rejects a full URL passed as the path", () => {
    const rejected = buildProxyEndpoint("linear", "https://evil.example.com/graphql");
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.message).toMatch(/full URL/);
  });

  it("rejects a path that doesn't begin with a slash", () => {
    const rejected = buildProxyEndpoint("linear", "graphql");
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.message).toMatch(/begin/);
  });

  it("supabase is the only connectable toolkit without a default host", () => {
    const withoutDefault = [...SUPPORTED_TOOLKITS]
      .filter((t) => !TOOLKIT_DEFAULT_API_HOST[t])
      .sort();
    expect(withoutDefault).toEqual(["supabase"]);
  });

  it("every default host clears its toolkit's allowlist (default route never fails open)", () => {
    for (const [toolkit, host] of Object.entries(TOOLKIT_DEFAULT_API_HOST)) {
      expect(validateProxyEndpoint(toolkit, `https://${host}/probe`)).toBeNull();
    }
  });
});

/**
 * `subscribeTriggerFeed` is the single arm-a-trigger path shared by the
 * `connector_event_subscribe` action and the dashboard's `POST /feeds` route, so
 * its rejection table is the contract both entry points inherit. These drive it
 * with a hand-built Composio double (only the three methods it calls) and assert
 * the observable discriminated result — not which collaborators ran.
 */

type CreateTriggerCall = {
  slug: string;
  connectedAccountId: string;
  triggerConfig: Record<string, unknown>;
};

function fakeClient(overrides: {
  triggerType?: { slug: string; toolkit: { slug: string } } | { throw: unknown };
  account?: Awaited<ReturnType<ComposioClient["findActiveConnectedAccount"]>>;
  onCreateTrigger?: (call: CreateTriggerCall) => void;
}): ComposioClient {
  return {
    getTriggerType: async (slug: string) => {
      const t = overrides.triggerType;
      if (t && "throw" in t) throw t.throw;
      return t ?? { slug, toolkit: { slug: "gmail" } };
    },
    findActiveConnectedAccount: async () => overrides.account ?? { kind: "ok", id: "ca_default" },
    createTrigger: async (
      _userId: string,
      slug: string,
      opts: { connectedAccountId: string; triggerConfig: Record<string, unknown> },
    ) => {
      overrides.onCreateTrigger?.({ slug, ...opts });
      return { triggerInstanceId: "ti_1" };
    },
  } as unknown as ComposioClient;
}

describe("subscribeTriggerFeed", () => {
  it("rejects a slug Composio does not recognize", async () => {
    const client = fakeClient({ triggerType: { throw: { status: 404 } } });
    const result = await subscribeTriggerFeed(client, {
      slug: "MYSTERY_TRIGGER",
      config: {},
    });
    expect(result).toEqual({
      ok: false,
      code: "unknown_trigger_slug",
      message: expect.stringContaining("MYSTERY_TRIGGER"),
    });
  });

  it("rejects a slug whose authoritative toolkit differs from the declared one", async () => {
    const client = fakeClient({
      triggerType: { slug: "GITHUB_STAR_ADDED", toolkit: { slug: "github" } },
    });
    const result = await subscribeTriggerFeed(client, {
      slug: "GITHUB_STAR_ADDED",
      config: {},
      expectedToolkit: "gmail",
    });
    expect(result).toMatchObject({ ok: false, code: "toolkit_mismatch" });
  });

  it("rejects when the toolkit has no active connected account", async () => {
    const client = fakeClient({
      triggerType: { slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: { slug: "gmail" } },
      account: { kind: "none" },
    });
    const result = await subscribeTriggerFeed(client, {
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      config: {},
      expectedToolkit: "gmail",
    });
    expect(result).toMatchObject({ ok: false, code: "no_connected_account" });
  });

  it("routes an unlinked Rome-managed toolkit to Settings, not connector_connect", async () => {
    const client = fakeClient({
      triggerType: { slug: "GITHUB_STAR_ADDED", toolkit: { slug: "github" } },
      account: { kind: "none" },
    });
    const result = await subscribeTriggerFeed(client, {
      slug: "GITHUB_STAR_ADDED",
      config: {},
      expectedToolkit: "github",
    });
    expect(result).toMatchObject({ ok: false, code: "no_connected_account" });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toMatch(/settings/i);
    expect(result.message).not.toMatch(/connector_connect/);
  });

  it("rejects an ambiguous account rather than guessing which to subscribe", async () => {
    const client = fakeClient({
      triggerType: { slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: { slug: "gmail" } },
      account: { kind: "ambiguous", ids: ["ca_1", "ca_2"] },
    });
    const result = await subscribeTriggerFeed(client, {
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      config: {},
      expectedToolkit: "gmail",
    });
    expect(result).toMatchObject({ ok: false, code: "ambiguous_connected_account" });
  });

  it("arms the trigger and returns the canonical eventName a routine binds to", async () => {
    const calls: CreateTriggerCall[] = [];
    const client = fakeClient({
      triggerType: { slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: { slug: "gmail" } },
      account: { kind: "ok", id: "ca_gmail" },
      onCreateTrigger: (c) => calls.push(c),
    });
    const result = await subscribeTriggerFeed(client, {
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      config: { labelIds: ["INBOX"] },
      expectedToolkit: "gmail",
    });
    expect(result).toEqual({
      ok: true,
      eventName: "provider:event:gmail.gmail_new_gmail_message",
      triggerInstanceId: "ti_1",
    });
    // The auto-resolved account and the caller's config reach Composio unchanged.
    expect(calls).toEqual([
      {
        slug: "GMAIL_NEW_GMAIL_MESSAGE",
        connectedAccountId: "ca_gmail",
        triggerConfig: { labelIds: ["INBOX"] },
      },
    ]);
  });

  it("uses an explicit connectedAccountId without resolving from the toolkit", async () => {
    const calls: CreateTriggerCall[] = [];
    let resolved = false;
    const client = {
      getTriggerType: async () => ({ slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: { slug: "gmail" } }),
      findActiveConnectedAccount: async () => {
        resolved = true;
        return { kind: "ok" as const, id: "ca_auto" };
      },
      createTrigger: async (
        _u: string,
        slug: string,
        opts: { connectedAccountId: string; triggerConfig: Record<string, unknown> },
      ) => {
        calls.push({ slug, ...opts });
        return { triggerInstanceId: "ti_2" };
      },
    } as unknown as ComposioClient;

    const result = await subscribeTriggerFeed(client, {
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      config: {},
      connectedAccountId: "ca_explicit",
    });
    expect(result).toMatchObject({ ok: true, triggerInstanceId: "ti_2" });
    expect(resolved).toBe(false);
    expect(calls[0].connectedAccountId).toBe("ca_explicit");
  });
});
