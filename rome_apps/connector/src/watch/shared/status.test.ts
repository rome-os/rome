import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import { createGithubAdapter } from "../adapters/github/index.js";
import { ADAPTERS } from "../registry.js";
import type { WatchEnv } from "../types.js";
import { composioServices, listWatchSources as listWith, NO_RELAY_REASON } from "./status.js";

/** What the statuses read, as fakes: GitHub's token and login, the relay, and Composio. */
interface WatchSourceDeps {
  githubToken(): Promise<string | null>;
  relayDepositUrl(): Promise<string | null>;
  githubLogin(token: string): Promise<string>;
  composioSignedIn(): Promise<boolean>;
  composioAccounts(): Promise<{ toolkit: string; status: string }[]>;
  composioAccount(service: string): Promise<string>;
}

/** The registry's adapters over the fakes: GitHub's deps injected, each Composio account read from them. */
const listWatchSources = (d: WatchSourceDeps) => {
  const github = createGithubAdapter({
    token: d.githubToken,
    login: d.githubLogin,
    isTeamMember: async () => false,
  });
  const adapters = ADAPTERS.map((adapter) =>
    adapter.source === github.source
      ? github
      : { ...adapter, account: () => d.composioAccount(adapter.source) },
  );
  const env: WatchEnv = {
    app: {} as AppActionRuntimeDeps,
    relayDepositUrl: d.relayDepositUrl,
    composio: {
      signedIn: d.composioSignedIn,
      accounts: d.composioAccounts,
      accountId: async () => "ca_test",
      read: async () => ({}),
      ensureTriggers: async () => ({ ok: true, subscription: "active" }),
    },
  };
  return listWith(adapters, env);
};

const deps = (extra: Partial<WatchSourceDeps> = {}): WatchSourceDeps => ({
  githubToken: async () => "gho_test",
  relayDepositUrl: async () => "https://relay.example/h/mbox",
  githubLogin: async () => "octo-me",
  composioSignedIn: async () => true,
  composioAccounts: async () => [
    { toolkit: "gmail", status: "ACTIVE" },
    { toolkit: "googlecalendar", status: "ACTIVE" },
    { toolkit: "linear", status: "ACTIVE" },
    { toolkit: "outlook", status: "ACTIVE" },
    { toolkit: "notion", status: "EXPIRED" },
    { toolkit: "stripe", status: "ACTIVE" },
  ],
  composioAccount: async (service) => (service === "stripe" ? "Acme Inc" : "me@example.com"),
  ...extra,
});

describe("composioServices", () => {
  it("lists the Composio services from the catalog, without the ones Rome manages", () => {
    const services = composioServices(
      [
        { toolkit: "gmail", status: "ACTIVE" },
        { toolkit: "notion", status: "EXPIRED" },
      ],
      true,
    );
    const ids = services.map((s) => s.service);
    expect(ids).toContain("gmail");
    expect(ids).not.toContain("github");
    expect(ids).not.toContain("slack");
    const byId = new Map(services.map((s) => [s.service, s]));
    expect(byId.get("gmail")).toMatchObject({ state: "working", connect: null });
    expect(byId.get("notion")?.state).toBe("broken");
    expect(byId.get("linear")).toMatchObject({
      state: null,
      connect: {
        kind: "composio",
        path: "/api/apps/connector/connectors",
        body: { provider: "linear" },
        needsLogin: false,
      },
    });
  });

  it("asks for the Composio sign-in first when Rome is not signed in", () => {
    const [first] = composioServices([], false);
    expect(first?.connect).toMatchObject({
      needsLogin: true,
      login: { method: "POST", path: "/api/apps/connector/login/start" },
    });
  });
});

describe("listWatchSources", () => {
  it("gives each watchable service its status, account, kinds with their bus events, and options", async () => {
    const { watch } = await listWatchSources(deps());
    expect(watch.map((w) => [w.service, w.status, w.account])).toEqual([
      ["github", "ready", "octo-me"],
      ["gmail", "ready", "me@example.com"],
      ["googlecalendar", "ready", "me@example.com"],
      ["linear", "ready", "me@example.com"],
      ["outlook", "ready", "me@example.com"],
      ["notion", "not_connected", undefined],
      ["stripe", "ready", "Acme Inc"],
    ]);
    expect(watch[1]?.kinds[0]?.triggers[0]?.eventName).toBe(
      "provider:event:gmail.gmail_new_gmail_message",
    );
  });

  it("says what is missing: a connection, the relay, or the account's identity", async () => {
    const off = await listWatchSources(
      deps({ githubToken: async () => null, composioSignedIn: async () => false }),
    );
    expect(new Set(off.watch.map((w) => w.status))).toEqual(new Set(["not_connected"]));
    const noRelay = await listWatchSources(deps({ relayDepositUrl: async () => null }));
    expect(noRelay.watch[0]).toMatchObject({ status: "no_relay", statusReason: NO_RELAY_REASON });
    const broken = await listWatchSources(
      deps({
        composioAccount: async (service) => {
          if (service === "gmail") throw new Error("Gmail answered 401");
          return "me@example.com";
        },
      }),
    );
    expect(broken.watch[1]).toMatchObject({
      status: "error",
      statusReason: expect.stringContaining("401"),
    });
  });

  it("reads the Calendar account on its own, so a Gmail-only Rome cannot watch Calendar", async () => {
    const gmailOnly = await listWatchSources(
      deps({ composioAccounts: async () => [{ toolkit: "gmail", status: "ACTIVE" }] }),
    );
    expect(gmailOnly.watch.map((w) => [w.service, w.status]).slice(0, 3)).toEqual([
      ["github", "ready"],
      ["gmail", "ready"],
      ["googlecalendar", "not_connected"],
    ]);
    const broken = await listWatchSources(
      deps({
        composioAccount: async (service) => {
          if (service === "googlecalendar") throw new Error("Google Calendar answered 403");
          return "me@example.com";
        },
      }),
    );
    expect(broken.watch[2]).toMatchObject({
      status: "error",
      statusReason: expect.stringContaining("403"),
    });
    expect(broken.watch[2]?.target).toBeNull();
  });
});
