import { describe, expect, it } from "@rstest/core";
import type { SessionActor } from "../lib/session-actor.js";
import {
  SKILL_REVIEW_INITIATOR,
  UsageAttributionResolver,
  type UsageAttributionSources,
} from "./attribution.js";

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

type Execution = NonNullable<Awaited<ReturnType<UsageAttributionSources["getExecution"]>>>;

/** An execution keyed by id: an initiator string, or the full row. */
type ExecutionSpec = string | Partial<Execution>;

function resolver(
  sessions: Record<string, Row>,
  executions: Record<string, ExecutionSpec> = {},
  firedBy: Record<string, string> = {},
) {
  return new UsageAttributionResolver(
    {
      getSession: async (id: string) => sessions[id] ?? null,
      getExecution: async (id: string) => {
        const spec = executions[id];
        if (spec === undefined) return null;
        const row = typeof spec === "string" ? { initiator: spec } : spec;
        return { initiator: null, actor: null, rootExecutionId: id, ...row };
      },
      getRoutineFiredBy: async ({ rootExecutionId }) => firedBy[rootExecutionId] ?? null,
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
    expect(await resolver(sessions).forTurn(turn("chat"))).toEqual({
      kind: "chat",
      appId: null,
      trigger: "user",
    });
    expect(await resolver(sessions).forTurn(turn("handoff"))).toEqual({
      kind: "chat",
      appId: null,
      trigger: "user",
    });
    expect(await resolver(sessions).forTurn(turn("telegram"))).toEqual({
      kind: "channel",
      appId: null,
      trigger: "user",
    });
    expect(await resolver(sessions).forTurn(turn("chat", "news_agent"))).toEqual({
      kind: "chat",
      appId: "@rome/news",
      trigger: "user",
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
      trigger: "user",
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
    const r = resolver(sessions, initiators, { "routine-run-root": "schedule" });
    expect(await r.forTurn(turn("routine"))).toEqual({
      kind: "routine",
      appId: null,
      trigger: "schedule",
    });
    expect(await r.forTurn(turn("appUi"))).toEqual({
      kind: "app",
      appId: "@rome/news",
      trigger: "background",
    });
    expect(await r.forTurn(turn("owned"))).toEqual({
      kind: "app",
      appId: "@rome/news",
      trigger: "unknown",
    });
    expect(await r.forTurn(turn("core"))).toEqual({
      kind: "other",
      appId: null,
      trigger: "event",
    });
  });

  it("gives an action session the trigger of the person or routine fire behind it", async () => {
    const guardian: SessionActor = { kind: "guardian", userId: "g", via: "cookie" };
    const sessions = {
      clicked: session({ type: "action", rootActionExecutionId: "exec-click" }),
      loopback: session({ type: "action", rootActionExecutionId: "exec-loopback" }),
      ranNow: session({
        type: "action",
        triggerExecutionId: "exec-ran-now",
        rootActionExecutionId: "run-now-root",
      }),
      onEmail: session({ type: "action", triggerExecutionId: "exec-on-email" }),
    };
    const executions: Record<string, ExecutionSpec> = {
      "exec-click": { initiator: "app:news", actor: guardian },
      "exec-loopback": {
        initiator: "app:news",
        actor: { kind: "guardian", userId: "g", via: "loopback" },
      },
      "exec-ran-now": "routine:Digest",
      // No session root id: the routine run is found through the execution.
      "exec-on-email": { initiator: "routine:Inbox", rootExecutionId: "email-root" },
    };
    const r = resolver(sessions, executions, {
      "run-now-root": "run_now",
      "email-root": "event-bus",
    });
    expect((await r.forTurn(turn("clicked"))).trigger).toBe("user");
    expect((await r.forTurn(turn("loopback"))).trigger).toBe("background");
    expect((await r.forTurn(turn("ranNow"))).trigger).toBe("user");
    expect((await r.forTurn(turn("onEmail"))).trigger).toBe("event");
  });

  it("counts the skill review core starts after a turn as background", async () => {
    const sessions = {
      review: session({
        type: "action",
        triggerExecutionId: "exec-review",
        rootActionExecutionId: "exec-review",
        triggerActionName: "news.digest",
      }),
    };
    const r = resolver(sessions, { "exec-review": SKILL_REVIEW_INITIATOR });
    expect(await r.forTurn(turn("review"))).toEqual({
      kind: "app",
      appId: "@rome/news",
      trigger: "background",
    });
  });

  it("falls back to the turn's session type when the row is missing or the root is gone", async () => {
    const sessions = { orphan: session({ type: "subagent", parentSessionId: "deleted" }) };
    const r = resolver(sessions);
    expect(
      await r.forTurn({ romeSessionId: "missing", fallbackType: "webchat", agentName: "main" }),
    ).toEqual({ kind: "chat", appId: null, trigger: "user" });
    expect(await r.forTurn(turn("orphan"))).toEqual({
      kind: "other",
      appId: null,
      trigger: "unknown",
    });
  });

  it("stops walking a lineage cycle", async () => {
    const sessions = {
      a: session({ type: "subagent", parentSessionId: "b" }),
      b: session({ type: "subagent", parentSessionId: "a" }),
    };
    expect(await resolver(sessions).forTurn(turn("a"))).toEqual({
      kind: "other",
      appId: null,
      trigger: "unknown",
    });
  });
});

describe("UsageAttributionResolver.forActionRun", () => {
  const r = resolver({}, {}, { "digest-root": "schedule", "poll-root": "poll" });
  const run = (actionName: string, initiator: string | null, extra: Partial<Execution> = {}) =>
    r.forActionRun({
      actionName,
      initiator,
      actor: null,
      rootExecutionId: "digest-root",
      ...extra,
    });

  it("reports routine fires and app-owned runs", async () => {
    expect(await run("core.memory", "routine:Digest")).toEqual({
      kind: "routine",
      appId: null,
      trigger: "schedule",
    });
    expect(await run("news.digest", "routine:Digest")).toEqual({
      kind: "routine",
      appId: "@rome/news",
      trigger: "schedule",
    });
    expect(await run("my_tool.run", "app:my_tool")).toEqual({
      kind: "app",
      appId: "local",
      trigger: "background",
    });
    expect(await run("news.digest", "webhook")).toEqual({
      kind: "app",
      appId: "@rome/news",
      trigger: "event",
    });
  });

  it("reports what fired a routine run", async () => {
    const fired = (rootExecutionId: string) =>
      run("core.memory", "routine:Digest", { rootExecutionId }).then((a) => a?.trigger);
    expect(await fired("poll-root")).toBe("schedule");
    expect(await fired("missing-root")).toBe("unknown");
    const manual = resolver({}, {}, { root: "run_now" });
    const webhook = resolver({}, {}, { root: "webhook" });
    const row = {
      actionName: "core.memory",
      initiator: "routine:Digest",
      actor: null,
      rootExecutionId: "root",
    };
    expect((await manual.forActionRun(row))?.trigger).toBe("user");
    expect((await webhook.forActionRun(row))?.trigger).toBe("event");
  });

  it("calls an app's run from a signed-in session user-initiated", async () => {
    const visitor: SessionActor = { kind: "visitor", accountId: "v", email: "v@example.com" };
    expect((await run("my_tool.run", "app:my_tool", { actor: visitor }))?.trigger).toBe("user");
  });

  // A sessionless call may be a person on a public page or a machine posting
  // to an app's unauthenticated route, such as a connector webhook.
  it("does not count a sessionless call as a person", async () => {
    expect(
      (await run("my_tool.run", "app:my_tool", { actor: { kind: "anonymous" } }))?.trigger,
    ).toBe("background");
  });

  it("does not count a Run now from the agent or a CLI over loopback as a person", async () => {
    const manual = resolver({}, {}, { root: "run_now" });
    const loopback: SessionActor = { kind: "guardian", userId: "g", via: "loopback" };
    const row = { actionName: "core.memory", initiator: "routine:Digest", rootExecutionId: "root" };
    expect((await manual.forActionRun({ ...row, actor: loopback }))?.trigger).toBe("background");
  });

  it("skips agent tool calls, channel delivery, startup work, and core webhooks", async () => {
    expect(await run("news.digest", "agent:main")).toBeNull();
    expect(await run("news.digest", "channel:webchat")).toBeNull();
    expect(await run("news.digest", "startup:system-events")).toBeNull();
    expect(await run("core.memory", "webhook")).toBeNull();
    expect(await run("core.memory", null)).toBeNull();
  });
});
