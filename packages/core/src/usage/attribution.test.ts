import { describe, expect, it } from "@rstest/core";
import { UsageAttributionResolver, type UsageAttributionSources } from "./attribution.js";

type Row = NonNullable<Awaited<ReturnType<UsageAttributionSources["getSession"]>>>;

function session(overrides: Partial<Row> & { type: string }): Row {
  return {
    agentName: null,
    parentSessionId: null,
    triggerExecutionId: null,
    rootActionExecutionId: null,
    triggerActionName: null,
    ...overrides,
  };
}

function resolver(sessions: Record<string, Row>, initiators: Record<string, string> = {}) {
  return new UsageAttributionResolver(
    {
      getSession: async (id) => sessions[id] ?? null,
      getExecutionInitiator: async (id) => initiators[id] ?? null,
    },
    {
      forAgent: (name) => (name === "news_agent" ? "@rome/news" : null),
      forAction: (name) =>
        name === "news.digest" ? "@rome/news" : name === "my_tool.run" ? "local" : null,
      forApp: (id) => (id === "news" ? "@rome/news" : "local"),
    },
  );
}

const turn = (romeSessionId: string, agentName = "main") => ({
  romeSessionId,
  fallbackType: "action" as const,
  agentName,
});

describe("UsageAttributionResolver.forTurn", () => {
  it("attributes chat, channel, and an app's agent in a chat", async () => {
    const sessions = {
      chat: session({ type: "webchat" }),
      handoff: session({ type: "webchat_handoff" }),
      telegram: session({ type: "channel" }),
    };
    expect(await resolver(sessions).forTurn(turn("chat"))).toEqual({ kind: "chat", appId: null });
    expect(await resolver(sessions).forTurn(turn("handoff"))).toEqual({
      kind: "chat",
      appId: null,
    });
    expect(await resolver(sessions).forTurn(turn("telegram"))).toEqual({
      kind: "channel",
      appId: null,
    });
    expect(await resolver(sessions).forTurn(turn("chat", "news_agent"))).toEqual({
      kind: "chat",
      appId: "@rome/news",
    });
  });

  it("gives subagent and fork turns the kind of their root session", async () => {
    const sessions = {
      chat: session({ type: "webchat" }),
      child: session({ type: "subagent", parentSessionId: "chat" }),
      grandchild: session({ type: "fork", parentSessionId: "child" }),
    };
    expect(await resolver(sessions).forTurn(turn("grandchild"))).toEqual({
      kind: "chat",
      appId: null,
    });
  });

  it("classifies action sessions by their root execution's initiator, then the action's owner", async () => {
    const sessions = {
      // A routine's chain carries the routine run's root id, which is no
      // execution row. The execution that started the agent is.
      routine: session({
        type: "action",
        triggerExecutionId: "exec-routine",
        rootActionExecutionId: "routine-run-root",
      }),
      appUi: session({ type: "action", rootActionExecutionId: "exec-app" }),
      owned: session({ type: "action", triggerActionName: "news.digest" }),
      core: session({ type: "action", rootActionExecutionId: "exec-webhook" }),
    };
    const initiators = {
      "exec-routine": "routine:Morning digest",
      "exec-app": "app:news",
      "exec-webhook": "webhook",
    };
    const r = resolver(sessions, initiators);
    expect(await r.forTurn(turn("routine"))).toEqual({ kind: "routine", appId: null });
    expect(await r.forTurn(turn("appUi"))).toEqual({ kind: "app", appId: "@rome/news" });
    expect(await r.forTurn(turn("owned"))).toEqual({ kind: "app", appId: "@rome/news" });
    expect(await r.forTurn(turn("core"))).toEqual({ kind: "other", appId: null });
  });

  it("falls back to the turn's session type when the row is missing or the root is gone", async () => {
    const sessions = { orphan: session({ type: "subagent", parentSessionId: "deleted" }) };
    const r = resolver(sessions);
    expect(
      await r.forTurn({ romeSessionId: "missing", fallbackType: "webchat", agentName: "main" }),
    ).toEqual({ kind: "chat", appId: null });
    expect(await r.forTurn(turn("orphan"))).toEqual({ kind: "other", appId: null });
  });

  it("stops walking a lineage cycle", async () => {
    const sessions = {
      a: session({ type: "subagent", parentSessionId: "b" }),
      b: session({ type: "subagent", parentSessionId: "a" }),
    };
    expect(await resolver(sessions).forTurn(turn("a"))).toEqual({ kind: "other", appId: null });
  });
});

describe("UsageAttributionResolver.forActionRun", () => {
  const r = resolver({});
  it("reports routine fires and app-owned runs", () => {
    expect(r.forActionRun({ actionName: "core.memory", initiator: "routine:Digest" })).toEqual({
      kind: "routine",
      appId: null,
    });
    expect(r.forActionRun({ actionName: "news.digest", initiator: "routine:Digest" })).toEqual({
      kind: "routine",
      appId: "@rome/news",
    });
    expect(r.forActionRun({ actionName: "my_tool.run", initiator: "app:my_tool" })).toEqual({
      kind: "app",
      appId: "local",
    });
    expect(r.forActionRun({ actionName: "news.digest", initiator: "webhook" })).toEqual({
      kind: "app",
      appId: "@rome/news",
    });
  });

  it("skips agent tool calls, channel delivery, startup work, and core webhooks", () => {
    expect(r.forActionRun({ actionName: "news.digest", initiator: "agent:main" })).toBeNull();
    expect(r.forActionRun({ actionName: "news.digest", initiator: "channel:webchat" })).toBeNull();
    expect(
      r.forActionRun({ actionName: "news.digest", initiator: "startup:system-events" }),
    ).toBeNull();
    expect(r.forActionRun({ actionName: "core.memory", initiator: "webhook" })).toBeNull();
    expect(r.forActionRun({ actionName: "core.memory", initiator: null })).toBeNull();
  });
});
