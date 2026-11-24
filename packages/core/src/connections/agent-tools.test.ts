import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  approvalOf,
  callTool,
  GUARDIAN_TURN,
  whoMayAskSuite,
} from "../apps/actions/agent-tool-contract.js";
import {
  type ConnectionToolDeps,
  connectService,
  disconnectService,
  type ListedConnection,
  readConnections,
} from "./agent-tools.js";
import type { Connection } from "./types.js";

whoMayAskSuite(readConnections, {});
whoMayAskSuite(connectService, { kind: "github" });
whoMayAskSuite(disconnectService, { connectionId: "conn-slack" });

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

function operations(overrides: Partial<ConnectionToolDeps> = {}) {
  const connection = { id: "conn-slack", connectionKind: "slack", label: "slack" } as Connection;
  const registry = {
    all: rs.fn(() => [connection]),
    getDescriptor: rs.fn(() => ({ label: "Slack", onDisconnect: async () => {} }) as never),
    disconnect: rs.fn(async () => ({})),
    remove: rs.fn(async () => {}),
  };
  const deps: ConnectionToolDeps = {
    connections: async () => [slack, github],
    registry,
    ...overrides,
  };
  const ops = {
    read: (input: Record<string, unknown>) => callTool(readConnections, deps, input),
    connect: (input: Record<string, unknown>, turn = GUARDIAN_TURN) =>
      callTool(connectService, deps, input, turn),
    disconnect: (input: Record<string, unknown>) => callTool(disconnectService, deps, input),
    approval: (input: Record<string, unknown>) => approvalOf(disconnectService, deps, input),
  };
  return { ops, registry };
}

describe("reading the connections", () => {
  it("lists each connection with its kind, state and account, and the kinds not connected", async () => {
    const { ops } = operations();

    expect(await ops.read({})).toEqual({
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

    const text = JSON.stringify(await ops.read({}));

    for (const field of ["/api/oauth", "setup-1", "authorized", "avatar", "grants", "talk"]) {
      expect(text).not.toContain(field);
    }
  });
});

describe("disconnecting a connection", () => {
  it("disconnects through the operation the Connections page uses", async () => {
    const { ops, registry } = operations();

    expect(await ops.disconnect({ connectionId: "conn-slack" })).toEqual({
      status: "ok",
      data: { connectionId: "conn-slack", kind: "slack", name: "Slack", disconnected: true },
    });
    expect(registry.disconnect).toHaveBeenCalledWith("conn-slack");
  });

  it("passes on the warning when the service may still hold Rome's access", async () => {
    const { ops, registry } = operations();
    registry.disconnect.mockImplementation(async () => ({ notTakenBack: "Slack was down" }));

    const result = await ops.disconnect({ connectionId: "conn-slack" });

    expect(result).toMatchObject({
      status: "ok",
      data: { warning: expect.stringContaining("Slack was down") },
    });
  });

  it("names system:read_connections for an id it does not know", async () => {
    const { ops } = operations();

    const result = await ops.disconnect({ connectionId: "nope" });

    expect(result.status === "error" && result.error).toContain("system:read_connections");
  });

  it("words the approval card with the connection's service and account", async () => {
    const { ops } = operations();

    expect(await ops.approval({ connectionId: "conn-slack" })).toEqual({
      kind: "generic",
      title: "Disconnect Slack (Acme)",
      summary:
        "Rome loses its access to Slack (Acme). To use it again, you connect it again in Settings › Connections.",
    });
  });

  it("words the approval card for an id it does not know with the way to find one", async () => {
    const { ops } = operations();

    expect(await ops.approval({ connectionId: "nope" })).toMatchObject({
      title: "Disconnect a connection",
      summary: expect.stringContaining("system:read_connections"),
    });
  });
});

describe("asking the guardian to connect a service", () => {
  // Where Rome Cloud is set up, as on a provisioned instance.
  beforeEach(() => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
  });
  afterEach(() => {
    rs.unstubAllEnvs();
  });

  it("returns core's connect card, which the chat draws and the agent waits on", async () => {
    const { ops } = operations();

    const result = await ops.connect({ kind: "github" });

    expect(result).toEqual({
      status: "pending_interaction",
      interaction: {
        appId: "core",
        promptText: "Connect GitHub to Rome, from Settings › Connections.",
        render: {
          kind: "inline",
          componentId: "connect-card",
          props: { kind: "github" },
          builtin: true,
        },
      },
    });
  });

  it("shows a device kind's card for the device the guardian asks from", async () => {
    const { ops } = operations({
      deviceKinds: () => [{ kind: "apple_health", label: "Apple Health" }],
      deviceState: (_kind, askingDeviceId) => ({ state: "off", askingDeviceId }),
    });

    const result = await ops.connect(
      { kind: "apple_health" },
      {
        ...GUARDIAN_TURN,
        channelContext: {
          channel: "webchat",
          threadId: "guardian-chat",
          askingDeviceId: "dev-1",
        } as never,
      },
    );

    expect(result).toMatchObject({
      status: "pending_interaction",
      interaction: {
        render: { props: { kind: "apple_health", device: true, deviceId: "dev-1" } },
      },
    });
  });

  it("answers with no card for a device kind that already works", async () => {
    const { ops } = operations({
      deviceKinds: () => [{ kind: "apple_health", label: "Apple Health" }],
      deviceState: () => ({ state: "working", device: "iPhone" }),
    });

    expect(await ops.connect({ kind: "apple_health" })).toEqual({
      status: "ok",
      data: { message: "Apple Health is already connected on iPhone. Go ahead; no card shown." },
    });
  });

  it("lists the kinds it connects for one it does not", async () => {
    const { ops } = operations();

    const result = await ops.connect({ kind: "notion" });

    expect(result.status === "error" && result.error).toContain('"github"');
  });

  it("sends a kind the card does not connect, such as Slack, to Settings", async () => {
    const { ops } = operations();

    const result = await ops.connect({ kind: "slack" });

    expect(result.status === "error" && result.error).toContain("Settings › Connections");
  });
});
