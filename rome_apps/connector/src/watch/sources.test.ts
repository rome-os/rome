import { describe, expect, it } from "@rstest/core";
import { listConnectors, NO_RELAY_REASON, type WatchSourceDeps } from "./sources.js";

const deps = (extra: Partial<WatchSourceDeps> = {}): WatchSourceDeps => ({
  githubToken: async () => "gho_test",
  relayDepositUrl: async () => "https://relay.example/h/mbox",
  githubLogin: async () => "octo-me",
  composioSignedIn: async () => true,
  composioAccounts: async () => [
    { toolkit: "gmail", status: "ACTIVE" },
    { toolkit: "notion", status: "ACTIVE" },
    { toolkit: "discord", status: "EXPIRED" },
  ],
  gmailAddress: async () => "me@example.com",
  romeManagedConnected: async (toolkit) => toolkit === "github",
  ...extra,
});

const byId = async (extra: Partial<WatchSourceDeps> = {}) =>
  new Map((await listConnectors(deps(extra))).map((c) => [c.id, c]));

describe("listConnectors", () => {
  it("lists the watchable connectors first, each with connection, act and watch", async () => {
    const connectors = await listConnectors(deps());
    expect(connectors.slice(0, 2).map((c) => c.id)).toEqual(["gmail", "github"]);
    const map = new Map(connectors.map((c) => [c.id, c]));
    expect(map.get("github")).toMatchObject({
      label: "GitHub",
      connection: { status: "connected" },
      act: true,
      watch: { status: "ready", account: "octo-me", target: { example: "rome-os/rome" } },
    });
    expect(map.get("gmail")?.watch).toMatchObject({ status: "ready", account: "me@example.com" });
    // Rome can act through a connected tool it cannot watch.
    expect(map.get("notion")).toMatchObject({
      act: true,
      watch: null,
      connection: { status: "connected" },
    });
  });

  it("gives a not-connected connector the call that starts connecting it", async () => {
    const map = await byId();
    expect(map.get("slack")?.connection).toEqual({
      status: "not_connected",
      reason: "Slack is not connected.",
      connect: { kind: "rome_oauth", method: "POST", path: "/api/oauth/slack/start" },
    });
    expect(map.get("discord")?.connection).toMatchObject({
      status: "expired",
      connect: {
        kind: "composio",
        path: "/api/apps/connector/connectors",
        body: { provider: "discord" },
        needsLogin: false,
      },
    });
    expect(map.get("slack")?.act).toBe(false);
  });

  it("asks for the Composio sign-in first when Rome is not signed in", async () => {
    const map = await byId({ composioSignedIn: async () => false });
    expect(map.get("gmail")?.connection.connect).toMatchObject({
      kind: "composio",
      needsLogin: true,
      login: { method: "POST", path: "/api/apps/connector/login/start" },
    });
    expect(map.get("gmail")?.watch).toMatchObject({
      status: "not_connected",
      statusReason: expect.stringMatching(/Settings → Connections/),
    });
  });

  it("says what is missing for watch: the relay, or the account's identity", async () => {
    const noRelay = await byId({ relayDepositUrl: async () => null });
    expect(noRelay.get("github")?.watch).toMatchObject({
      status: "no_relay",
      statusReason: NO_RELAY_REASON,
    });
    const broken = await byId({
      gmailAddress: async () => {
        throw new Error("Gmail's profile answered 401");
      },
    });
    expect(broken.get("gmail")?.watch).toMatchObject({
      status: "error",
      statusReason: expect.stringContaining("401"),
    });
  });
});
