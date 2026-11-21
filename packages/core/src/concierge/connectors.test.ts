import { describe, expect, it } from "@rstest/core";
import type { ConciergeConnectorDto } from "@rome/api-types/concierge";
import { agentViewOf, type ProviderWatchSection, watchCapabilityStatus } from "./connectors.js";

const section = (
  status: ProviderWatchSection["status"],
  statusReason?: string,
): ProviderWatchSection => ({
  service: "gmail",
  label: "Gmail",
  status,
  ...(statusReason ? { statusReason } : {}),
  target: null,
  kinds: [],
  options: [],
});

describe("watchCapabilityStatus", () => {
  it("maps a provider's watch status onto the connection model", () => {
    expect(watchCapabilityStatus(section("ready"))).toEqual({ state: "unlocked" });
    expect(watchCapabilityStatus(section("not_connected", "Gmail is not connected."))).toEqual({
      state: "needs-auth",
      missingGrants: [],
    });
    // Connected but unable to receive events: unlocked, degraded with the reason.
    expect(watchCapabilityStatus(section("no_relay", "No relay mailbox."))).toEqual({
      state: "unlocked",
      degradation: { reason: "No relay mailbox." },
    });
    expect(watchCapabilityStatus(section("error"))).toEqual({
      state: "unlocked",
      degradation: { reason: "error" },
    });
  });
});

describe("agentViewOf", () => {
  const github: ConciergeConnectorDto = {
    service: "github",
    label: "GitHub",
    icon: "brand:github",
    origin: "connection",
    connectionId: "c1",
    state: "working",
    account: "dana",
    connect: null,
    capabilities: {
      chat: { state: "unsupported" },
      act: { state: "unlocked" },
      watch: {
        state: "unlocked",
        target: { format: "owner/repo", example: "acme/widgets" },
        kinds: [{ kind: "pr", label: "Pull requests", default: true }],
        options: [],
        follows: [],
      },
    },
  };
  const gmail: ConciergeConnectorDto = {
    ...github,
    service: "gmail",
    label: "gmail",
    origin: "composio",
    connectionId: null,
    state: null,
    account: null,
    connect: { kind: "dashboard" },
    capabilities: {
      chat: { state: "unsupported" },
      act: { state: "needs-auth", missingGrants: [] },
      watch: { state: "unsupported" },
    },
  };
  const rules = { digestTimes: ["09:00"], quietHours: null } as never;

  it("leaves out what only a client needs, and the watch catalog", () => {
    expect(agentViewOf({ connectors: [github, gmail], rules })).toEqual({
      connectors: [
        {
          service: "github",
          label: "GitHub",
          state: "working",
          account: "dana",
          capabilities: {
            chat: { state: "unsupported" },
            act: { state: "unlocked" },
            watch: { state: "unlocked", follows: [] },
          },
        },
        {
          service: "gmail",
          state: null,
          capabilities: {
            chat: { state: "unsupported" },
            act: { state: "needs-auth", missingGrants: [] },
            watch: { state: "unsupported" },
          },
        },
      ],
      rules,
    });
  });

  it("answers one service with its catalog, and refuses one it does not list", () => {
    const one = agentViewOf({ connectors: [github, gmail], rules }, "github");
    expect(one.connectors).toHaveLength(1);
    expect(one.connectors[0]?.capabilities.watch).toEqual(github.capabilities.watch);
    expect(() => agentViewOf({ connectors: [github], rules }, "slack")).toThrow(/No service slack/);
  });

  it("keeps origin where a toolkit and a connection share a name", () => {
    const toolkit = { ...gmail, service: "github" };
    const view = agentViewOf({ connectors: [github, toolkit], rules });
    expect(view.connectors.map((entry) => entry.origin)).toEqual(["connection", "composio"]);
  });
});
