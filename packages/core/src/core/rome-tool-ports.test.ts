import { describe, expect, it, rs } from "@rstest/core";
import type { TurnFacts } from "../agent/index.js";
import type { ActionEngine } from "../apps/actions/engine.js";
import type { Action, ActionRegistry } from "../apps/actions/types.js";
import { currentSessionActor, runWithSessionActor } from "../access/session-actor.js";
import {
  claimTaskInputActor,
  taskInputActor,
  admitTaskInput,
} from "../webchat/task-input-actor.js";
import type { SessionToolContext } from "./session-tools.js";
import { romeToolPorts } from "./rome-tool-ports.js";

function action(name: string): Action {
  return {
    config: { name, description: `${name} action`, type: "task" },
    inputSchema: { type: "object", properties: {} },
  } as unknown as Action;
}

const ACTIONS = [action("system:send_message"), action("system:create_routine"), action("secret")];

const registry: ActionRegistry = {
  register: () => {},
  get: (name) =>
    ACTIONS.find((a) => a.config.name === (name === "send" ? "system:send_message" : name)),
  has: (name) => ACTIONS.some((a) => a.config.name === name),
  getCanonicalName: (name) => (name === "send" ? "system:send_message" : name),
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
    actions: ["system:send_message", "system:create_routine"],
    widgets: "card",
    turnId: () => "turn-1",
    live: () => true,
    threadContext: () => ({ channel: "webchat", threadId: "chat-1" }),
    sharedContext: () => undefined,
    pushLevel: () => undefined,
    actor: () => undefined,
    audience: () => "shared",
    reportedTask: () => undefined,
    inTurn: (fn) => fn(),
    ...overrides,
  };
}

function ports(
  sessionTools = rs.fn(async () => []),
  taskOwner?: (taskId: string) => Promise<string | null>,
  deviceKinds?: () => { kind: string; label: string }[],
) {
  const run = rs.fn(async () => ({ status: "ok" as const, data: { routineId: "r1" } }));
  const engine = { run } as unknown as ActionEngine;
  const getSession = rs.fn(async () => ({ ownerKey: null }));
  const built = romeToolPorts({
    actionRegistry: registry,
    actionEngine: engine,
    webchatRepo: { getSession } as never,
    ...(taskOwner ? { taskOwner } : {}),
    sessionTools,
    ...(deviceKinds ? { deviceKinds } : {}),
  });
  return { ...built, run, getSession, provided: sessionTools };
}

describe("romeToolPorts actions", () => {
  it("lists and permits only what the turn's agent may call, under any of its names", () => {
    const { actions } = ports();
    expect(actions.list(turn()).map((a) => a.name)).toEqual([
      "system:send_message",
      "system:create_routine",
    ]);
    expect(actions.permits(turn(), "send")).toBe(true);
    expect(actions.permits(turn(), "secret")).toBe(false);
  });

  it("finds an action the turn's agent may call under any of its names, and no other", () => {
    const { actions } = ports();
    expect(actions.find(turn(), "send")?.name).toBe("system:send_message");
    expect(actions.find(turn(), "system:send_message")?.name).toBe("system:send_message");
    expect(actions.find(turn(), "secret")).toBeUndefined();
    expect(actions.find(turn(), "missing")).toBeUndefined();
  });

  it("runs a permitted action attributed to the turn, and refuses any other", async () => {
    const { actions, run } = ports();
    await actions.run(turn(), "system:send_message", { text: "hi" });
    expect(run).toHaveBeenCalledWith(
      "system:send_message",
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

describe("romeToolPorts actions run as the turn's actor", () => {
  const visitor = { kind: "visitor" as const, accountId: "acct-v", email: "v@example.com" };
  const guardian = { kind: "guardian" as const, userId: "seat", via: "cookie" as const };

  it("runs a callback that arrives in another person's scope as the turn's actor", async () => {
    const { actions, run } = ports();
    const ambient: unknown[] = [];
    run.mockImplementation(async () => {
      ambient.push(await currentSessionActor());
      return { status: "ok" as const, data: { routineId: "r1" } };
    });
    // The model's callback lands in the guardian's scope, for the visitor's turn.
    await runWithSessionActor(guardian, () =>
      actions.run(turn({ actor: () => visitor }), "system:send_message", { text: "hi" }),
    );
    expect(run).toHaveBeenCalledWith(
      "system:send_message",
      { text: "hi" },
      expect.objectContaining({ actor: visitor }),
    );
    expect(ambient).toEqual([undefined]);
  });

  it("runs a turn no person started as no one, whatever scope its callback lands in", async () => {
    const { actions, run } = ports();
    const ambient: unknown[] = [];
    run.mockImplementation(async () => {
      ambient.push(await currentSessionActor());
      return { status: "ok" as const, data: { routineId: "r1" } };
    });
    await runWithSessionActor(visitor, () =>
      actions.run(turn(), "system:send_message", { text: "hi" }),
    );
    expect((run.mock.calls[0] as unknown[])[2]).not.toHaveProperty("actor");
    expect(ambient).toEqual([undefined]);
  });

  it("schedules a defer's wake as the turn's actor", async () => {
    const { defer, run } = ports();
    await runWithSessionActor(guardian, () =>
      defer.schedule(turn({ actor: () => visitor }), {
        kind: "time",
        name: "check CI",
        note: "Check CI.",
        fireAtMs: Date.now() + 60_000,
      }),
    );
    expect(run).toHaveBeenCalledWith(
      "system:create_routine",
      expect.anything(),
      expect.objectContaining({ actor: visitor }),
    );
  });
});

describe("romeToolPorts defer", () => {
  it("creates the wake through create_routine, owned by the dashboard chat's owner", async () => {
    const { defer, run, getSession } = ports();
    await defer.schedule(turn(), {
      kind: "time",
      name: "check CI",
      note: "Check the run and tell the guardian.",
      fireAtMs: Date.now() + 60_000,
    });
    expect(getSession).toHaveBeenCalledWith("chat-1");
    expect(run).toHaveBeenCalledWith(
      "system:create_routine",
      expect.anything(),
      expect.objectContaining({ sessionId: "session-1", turnId: "turn-1" }),
    );
  });
});

describe("romeToolPorts defer for a task chat", () => {
  const wake = (chatId: string) => ({
    kind: "time" as const,
    name: "check CI",
    note: "Check the run.",
    fireAtMs: Date.now() + 60_000,
    chatId,
  });

  it("schedules a check for a task of the chat's own owner", async () => {
    const { defer, run } = ports(undefined, async (id) => (id === "mine" ? "guardian" : null));
    await defer.schedule(turn(), wake("mine"));
    expect(run).toHaveBeenCalledWith("system:create_routine", expect.anything(), expect.anything());
  });

  it("refuses a task that is not there, or is another owner's, and schedules nothing", async () => {
    const { defer, run } = ports(undefined, async (id) =>
      id === "theirs" ? "visitor:acct-ann" : null,
    );
    for (const chatId of ["nope", "theirs"]) {
      await expect(defer.schedule(turn(), wake(chatId))).rejects.toThrow(`No task chat ${chatId}`);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe("romeToolPorts sessionTools", () => {
  it("serves no connect_service where the session's own tools show a connect card", async () => {
    const connectCard = {
      name: "connect_card",
      description: "",
      inputSchema: {},
      handler: async () => ({ content: [] }),
    };
    const { sessionTools } = ports(rs.fn(async () => [connectCard]));
    const tools = await sessionTools.forTurn(turn(), true);
    expect(tools.map((tool) => tool.name)).toEqual([
      "connect_card",
      "propose_routine",
      "share_location",
      "show_card",
    ]);
  });

  it("serves no second show_card where the session's own tools show an agent card", async () => {
    const ownCard = {
      name: "show_card",
      description: "",
      inputSchema: {},
      handler: async () => ({ content: [] }),
    };
    const { sessionTools } = ports(rs.fn(async () => [ownCard]));
    const tools = await sessionTools.forTurn(turn(), true);
    expect(tools.filter((tool) => tool.name === "show_card")).toEqual([ownCard]);
  });

  it("serves connect_service for device kinds alone beside the session's own connect card", async () => {
    const connectCard = {
      name: "connect_card",
      description: "",
      inputSchema: {},
      handler: async () => ({ content: [] }),
    };
    const { sessionTools } = ports(
      rs.fn(async () => [connectCard]),
      undefined,
      () => [{ kind: "apple_health", label: "Apple Health" }],
    );
    const tools = await sessionTools.forTurn(turn(), true);
    expect(tools.map((tool) => tool.name)).toEqual([
      "connect_card",
      "propose_routine",
      "connect_service",
      "share_location",
      "show_card",
    ]);
    const connect = tools.find((tool) => tool.name === "connect_service")!;
    const schema = connect.inputSchema as { properties: { kind: { enum: string[] } } };
    expect(schema.properties.kind.enum).toEqual(["apple_health"]);
    const refused = await connect.handler({ kind: "github" });
    expect(refused.isError).toBe(true);
  });

  it("serves the tools Rome adds, then propose_routine and connect_service, to a turn with a speaker", async () => {
    const extra = {
      name: "extra",
      description: "",
      inputSchema: {},
      handler: async () => ({ content: [] }),
    };
    const { sessionTools, provided } = ports(rs.fn(async () => [extra]));
    const tools = await sessionTools.forTurn(turn(), true);
    expect(tools.map((tool) => tool.name)).toEqual([
      "extra",
      "propose_routine",
      "connect_service",
      "share_location",
      "show_card",
    ]);
    expect(provided).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "core:main",
        sessionId: "session-1",
        isSubagent: false,
      }),
    );
  });

  it("serves only propose_routine, connect_service, share_location and show_card to a turn with no speaker", async () => {
    const { sessionTools, provided } = ports();
    const tools = await sessionTools.forTurn(turn(), false);
    expect(tools.map((tool) => tool.name)).toEqual([
      "propose_routine",
      "connect_service",
      "share_location",
      "show_card",
    ]);
    expect(provided).not.toHaveBeenCalled();
  });

  it("serves only connect_service, share_location and show_card, each refusing, where cards draw as plain text", async () => {
    const { sessionTools } = ports();
    const tools = await sessionTools.forTurn(turn({ widgets: "plain_text" }), true);
    expect(tools.map((tool) => tool.name)).toEqual([
      "connect_service",
      "share_location",
      "show_card",
    ]);
  });
});

describe("scoped task input from a session tool", () => {
  it("provides a turn-bound task input path rather than borrowing the callback's HTTP actor", async () => {
    let supplied: import("./session-tools.js").SessionToolContext | undefined;
    const provider = rs.fn(async (context) => {
      supplied = context;
      return [];
    });
    const { sessionTools } = ports(provider);
    await sessionTools.forTurn(turn({ agentName: "core:concierge" }), true);
    expect(typeof supplied?.captureTaskInput).toBe("function");
  });
});

describe("task input actor through the session tool port", () => {
  const guardian = { kind: "guardian" as const, userId: "synthetic-seat", via: "cookie" as const };
  const visitor = {
    kind: "visitor" as const,
    accountId: "synthetic-v",
    email: "v@example.invalid",
  };
  const body = { text: "free inspection only" };
  const speaker = { platform: "webchat", id: "core:concierge" };
  const thread = { channel: "webchat", threadId: "source", threadType: "private" as const };
  async function provided(overrides: Partial<TurnFacts> = {}) {
    let context!: SessionToolContext;
    const built = ports(
      rs.fn(async (value: SessionToolContext) => {
        context = value;
        return [];
      }),
    );
    await built.sessionTools.forTurn(
      turn({
        agentName: "core:concierge",
        actor: () => guardian,
        threadContext: () => thread,
        audience: () => "private",
        ...overrides,
      }),
      true,
    );
    return { ...built, context };
  }

  for (const [audience, actor] of [
    ["private", guardian],
    ["shared", guardian],
    ["shared", visitor],
  ] as const) {
    it(`captures a ${actor.kind}'s ${audience} source audience in the host handoff`, async () => {
      const { context } = await provided({ audience: () => audience, actor: () => actor });
      await context.captureTaskInput!()("target", body, async () => {
        expect(claimTaskInputActor("target", body, speaker)?.source.audience).toBe(audience);
      });
    });
  }

  it("revokes a handoff when the live audience changes", async () => {
    let audience: "private" | "shared" = "private";
    const { context } = await provided({ audience: () => audience });
    await context.captureTaskInput!()("target", body, async () => {
      audience = "shared";
      expect(() => claimTaskInputActor("target", body, speaker)).toThrow();
    });
  });

  it("carries the visitor turn, not the unrelated ambient guardian, into the task action", async () => {
    const built = await provided({ actor: () => visitor });
    const repo = {
      getSession: async (id: string) => ({
        id,
        ownerKey: "visitor:synthetic-v",
        archivedAt: null,
        ...(id === "source" ? { agentName: "core:concierge" } : { triggerKind: "concierge" }),
      }),
    };
    await runWithSessionActor(guardian, () =>
      built.context.captureTaskInput!()("target", body, async () => {
        expect(await currentSessionActor()).toBeUndefined();
        const claim = claimTaskInputActor("target", body, speaker)!;
        const actor = await taskInputActor(claim, repo as never, async () => "source");
        await admitTaskInput(claim, () =>
          built.actions.run(turn({ actor: () => actor }), "system:send_message", {}),
        );
      }),
    );
    expect(built.run).toHaveBeenCalledWith(
      "system:send_message",
      {},
      expect.objectContaining({ actor: visitor }),
    );
    const options = (built.run.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(options).not.toHaveProperty("approved");
    expect(options).not.toHaveProperty("replayJournal");
  });

  for (const [name, overrides] of [
    ["unknown actor", { actor: () => undefined }],
    ["anonymous actor", { actor: () => ({ kind: "anonymous" as const }) }],
    ["group", { threadContext: () => ({ ...thread, threadType: "group" as const }) }],
    ["missing privacy", { threadContext: () => ({ channel: "webchat", threadId: "source" }) }],
    ["other channel", { threadContext: () => ({ ...thread, channel: "discord" }) }],
    ["subagent", { isSubagent: true }],
    ["other agent", { agentName: "core:main" }],
    ["missing turn", { turnId: () => undefined }],
  ] as const) {
    it(`does not attribute a ${name} send, even in a guardian HTTP scope`, async () => {
      const { context } = await provided(overrides);
      await runWithSessionActor(guardian, () =>
        context.captureTaskInput!()("target", body, async () => {
          expect(await currentSessionActor()).toBeUndefined();
          expect(claimTaskInputActor("target", body, speaker)).toBeUndefined();
        }),
      );
    });
  }

  for (const change of ["actor", "turn", "privacy", "chat"] as const) {
    it(`revokes a pending handoff when its ${change} changes`, async () => {
      let liveActor: typeof guardian | undefined = guardian;
      let turnId = "original";
      let liveThread: import("@rome-os/app-runtime").ThreadContext = thread;
      const { context } = await provided({
        actor: () => liveActor,
        turnId: () => turnId,
        threadContext: () => liveThread,
      });
      await context.captureTaskInput!()("target", body, async () => {
        if (change === "actor") liveActor = undefined;
        if (change === "turn") turnId = "next";
        if (change === "privacy") liveThread = { ...thread, threadType: "group" };
        if (change === "chat") liveThread = { ...thread, threadId: "different" };
        expect(() => claimTaskInputActor("target", body, speaker)).toThrow();
      });
    });
  }
});

it("snapshots the source identity rather than following mutation of its objects", async () => {
  const actor = { kind: "guardian", userId: "synthetic-seat", via: "cookie" as const };
  const thread = { channel: "webchat", threadId: "source", threadType: "private" as const };
  let context!: SessionToolContext;
  const { sessionTools } = ports(
    rs.fn(async (value: SessionToolContext) => {
      context = value;
      return [];
    }),
  );
  await sessionTools.forTurn(
    turn({
      agentName: "core:concierge",
      actor: () => actor,
      threadContext: () => thread,
      audience: () => "private",
    }),
    true,
  );
  const body = { text: "synthetic" };
  await context.captureTaskInput!()("target", body, async () => {
    actor.kind = "visitor";
    expect(() =>
      claimTaskInputActor("target", body, { platform: "webchat", id: "core:concierge" }),
    ).toThrow();
  });
  actor.kind = "guardian";
  await context.captureTaskInput!()("target", body, async () => {
    thread.threadId = "another-source";
    expect(() =>
      claimTaskInputActor("target", body, { platform: "webchat", id: "core:concierge" }),
    ).toThrow();
  });
});

describe("task input source capture precedes asynchronous setup", () => {
  for (const initial of [
    undefined,
    { kind: "visitor", accountId: "synthetic-v" },
    { kind: "guardian", userId: "synthetic-seat" },
  ] as const) {
    it(`does not rebind an old ${initial?.kind ?? "autonomous"} callback to a newer guardian turn`, async () => {
      let actor: import("../agent/index.js").TurnActor | undefined = initial;
      let turnId = "original";
      let context!: SessionToolContext;
      const { sessionTools } = ports(
        rs.fn(async (value: SessionToolContext) => {
          context = value;
          return [];
        }),
      );
      await sessionTools.forTurn(
        turn({
          agentName: "core:concierge",
          actor: () => actor,
          turnId: () => turnId,
          audience: () => "private",
          threadContext: () => ({ channel: "webchat", threadId: "source", threadType: "private" }),
        }),
        true,
      );
      const sender = context.captureTaskInput!();
      await Promise.resolve();
      actor = { kind: "guardian", userId: "synthetic-seat" };
      turnId = "new-turn";
      const body = { text: "old callback" };
      const send = rs.fn(async () => {
        expect(await currentSessionActor()).toBeUndefined();
        expect(
          claimTaskInputActor("target", body, { platform: "webchat", id: "core:concierge" }),
        ).toBeUndefined();
        return {};
      });
      if (initial) {
        await expect(sender("target", body, send)).rejects.toThrow("source changed");
        expect(send).not.toHaveBeenCalled();
      } else {
        await runWithSessionActor(actor as never, () => sender("target", body, send));
        expect(send).toHaveBeenCalledTimes(1);
      }
    });
  }

  it("revokes only handoff liveness while keeping the visitor actor for other actions", async () => {
    const visitor = { kind: "visitor", accountId: "synthetic-v", email: "v@example.invalid" };
    let live = true;
    let context!: SessionToolContext;
    const built = ports(
      rs.fn(async (value: SessionToolContext) => {
        context = value;
        return [];
      }),
    );
    const facts = turn({
      agentName: "core:concierge",
      actor: () => visitor,
      live: () => live,
      threadContext: () => ({ channel: "webchat", threadId: "source", threadType: "private" }),
    });
    await built.sessionTools.forTurn(facts, true);
    const sender = context.captureTaskInput!();
    live = false;
    const send = rs.fn(async () => ({}));
    await expect(sender("target", { text: "stopped" }, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(() => context.captureTaskInput!()).toThrow("not live");
    await built.actions.run(facts, "system:send_message", {});
    expect(built.run).toHaveBeenCalledWith(
      "system:send_message",
      {},
      expect.objectContaining({ actor: visitor }),
    );
  });

  it("does not grant attribution when the host has no liveness fact", async () => {
    let context!: SessionToolContext;
    const built = ports(
      rs.fn(async (value: SessionToolContext) => {
        context = value;
        return [];
      }),
    );
    await built.sessionTools.forTurn(
      turn({
        agentName: "core:concierge",
        actor: () => ({ kind: "guardian", userId: "synthetic-seat" }),
        live: undefined,
        audience: () => "private",
        threadContext: () => ({ channel: "webchat", threadId: "source", threadType: "private" }),
      }),
      true,
    );
    const body = { text: "unknown liveness" };
    await context.captureTaskInput!()("target", body, async () => {
      expect(
        claimTaskInputActor("target", body, { platform: "webchat", id: "core:concierge" }),
      ).toBeUndefined();
    });
  });
});
