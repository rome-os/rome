import { describe, expect, it, rs } from "@rstest/core";
import {
  type ConnectionOperationDeps,
  type ConnectionTurn,
  connectionOperations,
  type ListedConnection,
} from "./control.js";
import type { Connection } from "./types.js";

const guardianAsked: ConnectionTurn = {
  actor: { kind: "guardian", userId: "guardian", via: "cookie" },
  audience: "private",
};
const visitorAsked: ConnectionTurn = {
  actor: { kind: "visitor", accountId: "acct-1" } as never,
  audience: "shared",
};

const unlocked = { state: "unlocked" } as const;
const unsupported = { state: "unsupported" } as const;

// Two rows as `GET /api/connections` lists them, with the fields the page reads
// beyond what the agent gets: the connect link, live setups, per-grant state.
const slack = {
  id: "conn-slack",
  connectionKind: "slack",
  service: "slack",
  label: "slack",
  kindLabel: "Slack",
  state: "working",
  grants: { bot: "authorized" },
  display: {
    bot: { displayName: "Acme", handle: "acme", email: null, avatarUrl: "https://x/a.png" },
  },
  capabilities: { chat: unlocked, act: unlocked, watch: unsupported, talk: unlocked },
  connect: { url: "/api/oauth/slack/start", available: true, unavailableReason: null },
  setups: { bot: "setup-1" },
  agent: "main",
} as ListedConnection;
const github = {
  id: null,
  connectionKind: "github",
  label: "github",
  kindLabel: "GitHub",
  state: null,
  display: { oauth: null },
  capabilities: {
    chat: unsupported,
    act: { state: "needs-auth", missingGrants: ["oauth"] },
    watch: unsupported,
  },
} as ListedConnection;

function operations(overrides: Partial<ConnectionOperationDeps> = {}) {
  const connection = { id: "conn-slack", connectionKind: "slack", label: "slack" } as Connection;
  const registry = {
    all: rs.fn(() => [connection]),
    getDescriptor: rs.fn(() => ({ label: "Slack", onDisconnect: async () => {} }) as never),
    disconnect: rs.fn(async () => ({})),
    remove: rs.fn(async () => {}),
  };
  const ops = connectionOperations({
    connections: async () => [slack, github],
    registry,
    worksForGuardian: async (turn) => turn.actor?.kind === "guardian",
    changeRefusalReason: (turn) =>
      turn.audience !== "private"
        ? "not_private"
        : turn.actor?.kind === "guardian"
          ? null
          : "not_guardian",
    ...overrides,
  });
  return { ops, registry };
}

describe("reading the connections", () => {
  it("lists each connection with its kind, state and account, and the kinds not connected", async () => {
    const { ops } = operations();

    expect(await ops.read({}, guardianAsked)).toEqual({
      status: "ok",
      data: {
        connections: [
          {
            connectionId: "conn-slack",
            kind: "slack",
            name: "Slack",
            state: "working",
            account: { name: "Acme", agent: "main" },
            capabilities: { chat: "unlocked", act: "unlocked" },
          },
        ],
        notConnected: [{ kind: "github", name: "GitHub" }],
      },
    });
  });

  it("carries no link, setup or grant of the page's rows", async () => {
    const { ops } = operations();

    const text = JSON.stringify(await ops.read({}, guardianAsked));

    for (const field of ["/api/oauth", "setup-1", "authorized", "avatar", "grants", "talk"]) {
      expect(text).not.toContain(field);
    }
  });

  it("refuses a turn that does not work for the guardian", async () => {
    const { ops } = operations();

    const result = await ops.read({}, visitorAsked);

    expect(result).toMatchObject({ status: "error" });
    expect(result.status === "error" && result.error).toMatch(/^connections_guardian_only: /);
  });
});

describe("disconnecting a connection", () => {
  it("disconnects through the operation the Connections page uses", async () => {
    const { ops, registry } = operations();

    expect(await ops.disconnect({ connectionId: "conn-slack" }, guardianAsked)).toEqual({
      status: "ok",
      data: { connectionId: "conn-slack", kind: "slack", name: "Slack", disconnected: true },
    });
    expect(registry.disconnect).toHaveBeenCalledWith("conn-slack");
  });

  it("passes on the warning when the service may still hold Rome's access", async () => {
    const { ops, registry } = operations();
    registry.disconnect.mockImplementation(async () => ({ notTakenBack: "Slack was down" }));

    const result = await ops.disconnect({ connectionId: "conn-slack" }, guardianAsked);

    expect(result).toMatchObject({
      status: "ok",
      data: { warning: expect.stringContaining("Slack was down") },
    });
  });

  it("refuses a turn the guardian's own message did not start, and disconnects nothing", async () => {
    const { ops, registry } = operations();

    const shared = await ops.disconnect({ connectionId: "conn-slack" }, visitorAsked);
    const notGuardian = await ops.disconnect(
      { connectionId: "conn-slack" },
      { ...visitorAsked, audience: "private" },
    );

    expect(shared.status === "error" && shared.error).toMatch(/^connection_private_only: /);
    expect(notGuardian.status === "error" && notGuardian.error).toMatch(
      /^connection_needs_guardian: /,
    );
    expect(registry.disconnect).not.toHaveBeenCalled();
    expect(registry.remove).not.toHaveBeenCalled();
  });

  it("names system:read_connections for an id it does not know", async () => {
    const { ops } = operations();

    const result = await ops.disconnect({ connectionId: "nope" }, guardianAsked);

    expect(result.status === "error" && result.error).toContain("system:read_connections");
  });

  it("words the approval card with the connection's service and account", async () => {
    const { ops } = operations();

    expect(await ops.previewDisconnect({ connectionId: "conn-slack" }, visitorAsked)).toEqual({
      status: "ok",
      data: {
        kind: "generic",
        title: "Disconnect Slack (Acme)",
        summary:
          "Rome loses its access to Slack (Acme). To use it again, you connect it again in Settings › Connections.",
      },
    });
  });
});
