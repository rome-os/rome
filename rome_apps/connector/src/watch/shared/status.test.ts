import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";
import { createGithubAdapter } from "../adapters/github/index.js";
import { ADAPTERS } from "../registry.js";
import type { ActiveTrigger } from "../../api/composio-client.js";
import type { WatchEnv } from "../types.js";
import {
  COMPOSIO_TRIGGER_MISSING_REASON,
  COMPOSIO_WEBHOOK_ELSEWHERE_REASON,
  composioServices,
  listWatchSources as listWith,
  NO_RELAY_REASON,
} from "./status.js";

/** What the statuses read, as fakes: GitHub's token and login, the relay, and Composio. */
interface WatchSourceDeps {
  githubToken(): Promise<string | null>;
  relayDepositUrl(): Promise<string | null>;
  githubLogin(token: string): Promise<string>;
  composioSignedIn(): Promise<boolean>;
  composioAccounts(): Promise<{ toolkit: string; status: string }[]>;
  composioAccount(service: string): Promise<string>;
  composioWebhookTarget(): Promise<"ours" | "elsewhere" | "none" | "unknown">;
  composioActiveTriggers(): Promise<ActiveTrigger[]>;
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
      webhookTarget: d.composioWebhookTarget,
      activeTriggers: d.composioActiveTriggers,
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
  composioWebhookTarget: async () => "ours",
  // Unknown unless a case says otherwise, so no kind is flagged.
  composioActiveTriggers: async () => Promise.reject(new Error("not read in this case")),
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

  it("asks every adapter's service at once, and keeps the adapters' order", async () => {
    let inFlight = 0;
    let most = 0;
    const { watch } = await listWatchSources(
      deps({
        composioAccount: async (service) => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((resolve) => setTimeout(resolve, service === "gmail" ? 20 : 1));
          inFlight -= 1;
          return `${service}@example.com`;
        },
      }),
    );
    expect(most).toBeGreaterThan(1);
    expect(watch.map((w) => w.service)).toEqual(ADAPTERS.map((a) => a.source));
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

  it("says a Composio source cannot receive events when the project's webhook goes to another Rome", async () => {
    const target = rs.fn(async () => "elsewhere" as const);
    const { watch } = await listWatchSources(deps({ composioWebhookTarget: target }));
    expect(watch.map((w) => [w.service, w.status])).toEqual([
      ["github", "ready"],
      ["gmail", "error"],
      ["googlecalendar", "error"],
      ["linear", "error"],
      ["outlook", "error"],
      ["notion", "not_connected"],
      ["stripe", "error"],
    ]);
    expect(watch[1]?.statusReason).toBe(COMPOSIO_WEBHOOK_ELSEWHERE_REASON);
    expect(target).toHaveBeenCalledTimes(1);
  });

  it("leaves Composio sources ready when where the webhook goes is unknown or none", async () => {
    for (const answer of ["unknown", "none"] as const) {
      const { watch } = await listWatchSources(deps({ composioWebhookTarget: async () => answer }));
      expect(watch.filter((w) => w.status === "error")).toEqual([]);
    }
    const failing = await listWatchSources(
      deps({ composioWebhookTarget: async () => Promise.reject(new Error("fetch failed")) }),
    );
    expect(failing.watch.filter((w) => w.status === "error")).toEqual([]);
  });

  it("says which kinds of a ready Composio source have no active trigger, and leaves GitHub alone", async () => {
    const active = rs.fn(async (): Promise<ActiveTrigger[]> => []);
    const { watch } = await listWatchSources(deps({ composioActiveTriggers: active }));
    const byService = new Map(watch.map((w) => [w.service, w]));
    expect(byService.get("gmail")).toMatchObject({
      status: "ready",
      undelivered: { kinds: ["new_mail"], reason: COMPOSIO_TRIGGER_MISSING_REASON },
    });
    expect(byService.get("github")?.undelivered).toBeUndefined();
    expect(byService.get("notion")?.undelivered).toBeUndefined();
    expect(active).toHaveBeenCalledTimes(1);
  });

  it("flags no kind when the triggers cannot be read, and the webhook going elsewhere wins", async () => {
    const unknown = await listWatchSources(deps());
    expect(unknown.watch.filter((w) => w.undelivered)).toEqual([]);
    const elsewhere = await listWatchSources(
      deps({
        composioWebhookTarget: async () => "elsewhere",
        composioActiveTriggers: async () => [],
      }),
    );
    expect(elsewhere.watch.find((w) => w.service === "gmail")).toMatchObject({
      status: "error",
      statusReason: COMPOSIO_WEBHOOK_ELSEWHERE_REASON,
    });
    expect(elsewhere.watch.filter((w) => w.undelivered)).toEqual([]);
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
