import { describe, expect, it, rs } from "@rstest/core";
import type { TurnFacts } from "../agent/index.js";
import type { ActionEngine } from "../apps/actions/engine.js";
import type { Action, ActionRegistry } from "../apps/actions/types.js";
import { romeToolPorts } from "./rome-tool-ports.js";

function action(name: string): Action {
  return {
    config: { name, description: `${name} action`, type: "task" },
    inputSchema: { type: "object", properties: {} },
  } as unknown as Action;
}

const ACTIONS = [action("send_message"), action("create_routine"), action("secret")];

const registry: ActionRegistry = {
  register: () => {},
  get: (name) => ACTIONS.find((a) => a.config.name === (name === "send" ? "send_message" : name)),
  has: (name) => ACTIONS.some((a) => a.config.name === name),
  getCanonicalName: (name) => (name === "send" ? "send_message" : name),
  list: () => ACTIONS.map((a) => a.config.name),
  getForAgent: (names) =>
    names.includes("*") ? ACTIONS : ACTIONS.filter((a) => names.includes(a.config.name)),
};

function turn(overrides: Partial<TurnFacts> = {}): TurnFacts {
  return {
    agentName: "core:main",
    continuityKey: "webchat:chat-1",
    sessionId: "session-1",
    isSubagent: false,
    actions: ["send_message", "create_routine"],
    widgets: "card",
    turnId: () => "turn-1",
    threadContext: () => ({ channel: "webchat", threadId: "chat-1" }),
    sharedContext: () => undefined,
    pushLevel: () => undefined,
    inTurn: (fn) => fn(),
    ...overrides,
  };
}

function ports(sessionTools = rs.fn(async () => [])) {
  const run = rs.fn(async () => ({ status: "ok" as const, data: { routineId: "r1" } }));
  const engine = { run } as unknown as ActionEngine;
  const getSession = rs.fn(async () => ({ ownerKey: null }));
  const built = romeToolPorts({
    actionRegistry: registry,
    actionEngine: engine,
    webchatRepo: { getSession } as never,
    sessionTools,
  });
  return { ...built, run, getSession, provided: sessionTools };
}

describe("romeToolPorts actions", () => {
  it("lists and permits only what the turn's agent may call, under any of its names", () => {
    const { actions } = ports();
    expect(actions.list(turn()).map((a) => a.name)).toEqual(["send_message", "create_routine"]);
    expect(actions.permits(turn(), "send")).toBe(true);
    expect(actions.permits(turn(), "secret")).toBe(false);
  });

  it("runs a permitted action attributed to the turn, and refuses any other", async () => {
    const { actions, run } = ports();
    await actions.run(turn(), "send_message", { text: "hi" });
    expect(run).toHaveBeenCalledWith(
      "send_message",
      { text: "hi" },
      expect.objectContaining({
        initiator: "agent:core:main",
        sessionId: "session-1",
        channelThreadKey: "webchat:chat-1",
        turnId: "turn-1",
      }),
    );
    await expect(actions.run(turn(), "secret", {})).rejects.toThrow("Unknown action: secret");
    await expect(actions.run(turn(), "missing", {})).rejects.toThrow("Unknown action: missing");
  });
});

describe("romeToolPorts defer", () => {
  it("creates the wake through create_routine, owned by the dashboard chat's owner", async () => {
    const { defer, run, getSession } = ports();
    await defer.schedule(turn(), { kind: "time", name: "check CI", fireAtMs: Date.now() + 60_000 });
    expect(getSession).toHaveBeenCalledWith("chat-1");
    expect(run).toHaveBeenCalledWith(
      "create_routine",
      expect.anything(),
      expect.objectContaining({ sessionId: "session-1", turnId: "turn-1" }),
    );
  });
});

describe("romeToolPorts sessionTools", () => {
  it("serves the tools Rome adds, then propose_routine, to a turn with a speaker", async () => {
    const extra = {
      name: "extra",
      description: "",
      inputSchema: {},
      handler: async () => ({ content: [] }),
    };
    const { sessionTools, provided } = ports(rs.fn(async () => [extra]));
    const tools = await sessionTools.forTurn(turn(), true);
    expect(tools.map((tool) => tool.name)).toEqual(["extra", "propose_routine"]);
    expect(provided).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "core:main",
        sessionId: "session-1",
        isSubagent: false,
      }),
    );
  });

  it("serves only propose_routine to a turn with no speaker", async () => {
    const { sessionTools, provided } = ports();
    const tools = await sessionTools.forTurn(turn(), false);
    expect(tools.map((tool) => tool.name)).toEqual(["propose_routine"]);
    expect(provided).not.toHaveBeenCalled();
  });

  it("serves no propose_routine where cards draw as plain text", async () => {
    const { sessionTools } = ports();
    expect(await sessionTools.forTurn(turn({ widgets: "plain_text" }), true)).toEqual([]);
  });
});
