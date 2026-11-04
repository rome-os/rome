import { describe, expect, it } from "@rstest/core";
import { listWatchSources, NO_RELAY_REASON, type WatchSourceDeps } from "./sources.js";

const deps = (extra: Partial<WatchSourceDeps> = {}): WatchSourceDeps => ({
  githubToken: async () => "gho_test",
  relayDepositUrl: async () => "https://relay.example/h/mbox",
  githubLogin: async () => "octo-me",
  composioSignedIn: async () => true,
  composioToolkits: async () => ["gmail", "notion"],
  gmailAddress: async () => "me@example.com",
  romeManagedToolkits: async () => ["slack"],
  ...extra,
});

const statusOf = (sources: Awaited<ReturnType<typeof listWatchSources>>) =>
  sources.map(({ source, status, account }) => ({
    source,
    status,
    ...(account ? { account } : {}),
  }));

describe("listWatchSources", () => {
  it("lists GitHub and Gmail as ready with their accounts, and other connected apps as not supported", async () => {
    const sources = await listWatchSources(deps());
    expect(statusOf(sources)).toEqual([
      { source: "github", status: "ready", account: "octo-me" },
      { source: "gmail", status: "ready", account: "me@example.com" },
      { source: "notion", status: "not_supported" },
      { source: "slack", status: "not_supported" },
    ]);
    const github = sources[0]!;
    expect(github.target?.format).toBe("A repository as owner/name");
    expect(github.kinds.find((k) => k.kind === "new_pr_or_issue")).toMatchObject({
      default: false,
      requires: { option: "scope", value: "whole_repo" },
    });
    expect(github.options.map((o) => o.key)).toEqual([
      "scope",
      "ignorePeople",
      "onlyPeople",
      "includeBots",
    ]);
    expect(sources[2]?.statusReason).toBe("Notion is connected, but Rome cannot follow it yet.");
  });

  it("says what is missing: a connection, the relay, or an identity", async () => {
    const disconnected = await listWatchSources(
      deps({ githubToken: async () => null, composioSignedIn: async () => false }),
    );
    expect(statusOf(disconnected).slice(0, 2)).toEqual([
      { source: "github", status: "not_connected" },
      { source: "gmail", status: "not_connected" },
    ]);
    expect(disconnected[0]?.statusReason).toMatch(/Settings → Connections/);

    const noRelay = await listWatchSources(deps({ relayDepositUrl: async () => null }));
    expect(noRelay.slice(0, 2).map((s) => [s.status, s.statusReason])).toEqual([
      ["no_relay", NO_RELAY_REASON],
      ["no_relay", NO_RELAY_REASON],
    ]);

    const broken = await listWatchSources(
      deps({
        gmailAddress: async () => {
          throw new Error("Gmail's profile answered 401");
        },
      }),
    );
    expect(broken[1]).toMatchObject({
      status: "error",
      statusReason: expect.stringContaining("401"),
    });
  });
});
