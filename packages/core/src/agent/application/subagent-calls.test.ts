import { describe, expect, it, rs } from "@rstest/core";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { DashboardSession, DashboardSessions } from "../domain/dashboard-sessions.js";
import {
  createSubagentCalls,
  type CallingTurn,
  type SubagentSession,
  type SubagentSessions,
} from "./subagent-calls.js";

const event = (e: object) => e as StreamAgentEvent;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function fakeSession(id: string, events: () => AsyncIterable<StreamAgentEvent>) {
  const submitted: unknown[][] = [];
  const session: SubagentSession = {
    id,
    submit: (...args) => {
      submitted.push(args);
      return { turnId: `${id}-turn`, events: events() };
    },
    stop: rs.fn(async () => undefined),
  };
  return { session, submitted };
}

function answering(text: string, wait?: Promise<void>) {
  return async function* () {
    yield event({ type: "text", content: "working" });
    await wait;
    yield event({ type: "result", content: text });
    yield event({ type: "turn_end", status: "completed" });
  };
}

function setup(rows: Record<string, DashboardSession> = {}) {
  const added: unknown[] = [];
  const order: string[] = [];
  const dashboard: DashboardSessions = {
    parentSession: async () => null,
    get: async (id) => rows[id] ?? null,
    addSubagentSession: async (session) => {
      order.push("add");
      added.push(session);
    },
  };
  const logged: StreamAgentEvent[] = [];
  const published: StreamAgentEvent[] = [];
  const finish = rs.fn();
  const stops: Array<(reason?: string) => Promise<void>> = [];
  const calls = createSubagentCalls({
    dashboard,
    turnLog: { open: () => ({ record: async (e) => void logged.push(e) }) },
    liveTurns: {
      register: (turn) => {
        stops.push(turn.stop);
        return { publish: (e) => void published.push(e), finish };
      },
    },
  });
  return { calls, added, order, logged, published, finish, stops };
}

const parentRow: DashboardSession = {
  type: "webchat",
  name: "Trip",
  agentName: null,
  parentSessionId: null,
  projectName: "trip",
  projectPath: "/p/trip",
};

function callingTurn(sessions: SubagentSessions, toolUseId = "tool-1"): CallingTurn {
  return {
    key: { dashboardSessionId: "chat", turnId: "turn-1", toolUseId },
    agentName: "core:main",
    agentSessionId: "agent-session",
    sessions,
    at: { workingDir: "/p/trip" },
  };
}

describe("SubagentCalls", () => {
  it("opens a fresh session, adds it to the dashboard, and answers with the turn's result", async () => {
    const { calls, added, order, logged, published, finish } = setup({ chat: parentRow });
    const child = fakeSession("sub-1", answering("done"));
    const sessions: SubagentSessions = {
      open: async () => {
        order.push("open");
        return child.session;
      },
      resume: rs.fn(),
    };

    const call = await calls.call("core:helper", { prompt: "plan" }, callingTurn(sessions));

    expect(order).toEqual(["open", "add"]);
    expect(added).toEqual([
      {
        id: "sub-1",
        name: "core:helper: Trip",
        agentName: "core:helper",
        projectName: "trip",
        projectPath: "/p/trip",
        parentSessionId: "chat",
        parentTurnId: "turn-1",
      },
    ]);
    expect(child.submitted[0].slice(0, 2)).toEqual([
      "plan",
      { sessionId: "agent-session", turnId: "turn-1", agentName: "core:main" },
    ]);
    expect(call).toMatchObject({
      subagent: "core:helper",
      sessionId: "sub-1",
      turnId: "sub-1-turn",
    });
    await expect(call.outcome).resolves.toEqual({ status: "completed", output: "done" });
    expect(published.map((e) => e.type)).toEqual(["text", "result", "turn_end"]);
    expect(logged).toEqual(published);
    await Promise.resolve();
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("refuses a resume before opening anything", async () => {
    const { calls } = setup({ chat: parentRow });
    const sessions: SubagentSessions = { open: rs.fn(), resume: rs.fn() };
    await expect(
      calls.call(
        "core:helper",
        { prompt: "go", resumeSessionId: "someone-else" },
        callingTurn(sessions),
      ),
    ).rejects.toThrow('Subagent session "someone-else" was not found');
    expect(sessions.open).not.toHaveBeenCalled();
    expect(sessions.resume).not.toHaveBeenCalled();
  });

  it("resumes a session the same parent started, without adding it again", async () => {
    const stored: DashboardSession = {
      ...parentRow,
      type: "subagent",
      agentName: "core:helper",
      parentSessionId: "chat",
    };
    const { calls, added } = setup({ chat: parentRow, sub: stored });
    const child = fakeSession("sub", answering("again"));
    const sessions: SubagentSessions = {
      open: rs.fn(),
      resume: rs.fn(async () => child.session),
    };
    const call = await calls.call(
      "core:helper",
      { prompt: "go", resumeSessionId: "sub" },
      callingTurn(sessions),
    );
    expect(sessions.resume).toHaveBeenCalledWith("sub", "core:helper", { workingDir: "/p/trip" });
    expect(added).toEqual([]);
    await expect(call.outcome).resolves.toMatchObject({ output: "again" });
  });

  it("holds a call until it is forgotten, and forgetting does not cancel it", async () => {
    const { calls } = setup({ chat: parentRow });
    const wait = gate();
    const child = fakeSession("sub", answering("done", wait.opened));
    const sessions: SubagentSessions = { open: async () => child.session, resume: rs.fn() };
    const turn = callingTurn(sessions);
    const call = await calls.call("core:helper", { prompt: "go" }, turn);

    expect(calls.forget(turn.key)).toBe(true);
    expect(calls.forget(turn.key)).toBe(false);
    expect(child.session.stop).not.toHaveBeenCalled();
    wait.open();
    await expect(call.outcome).resolves.toMatchObject({ status: "completed" });
  });

  it("stops the subagent's turn and fails when a call with the same key is held", async () => {
    const { calls, finish } = setup({ chat: parentRow });
    const wait = gate();
    const first = fakeSession("sub-1", answering("one", wait.opened));
    const second = fakeSession("sub-2", answering("two", wait.opened));
    const next = [first.session, second.session];
    const sessions: SubagentSessions = { open: async () => next.shift()!, resume: rs.fn() };

    await calls.call("core:helper", { prompt: "one" }, callingTurn(sessions));
    await expect(
      calls.call("core:helper", { prompt: "two" }, callingTurn(sessions)),
    ).rejects.toThrow("Active subagent link already exists for parent chat/turn-1/tool-1");
    expect(second.session.stop).toHaveBeenCalledWith("subagent registration failed");
    expect(finish).toHaveBeenCalledTimes(1);
    wait.open();
  });

  it("cancels by stopping the turn, and does nothing once the outcome has settled", async () => {
    const { calls, stops } = setup({ chat: parentRow });
    const wait = gate();
    const child = fakeSession("sub", answering("done", wait.opened));
    const sessions: SubagentSessions = { open: async () => child.session, resume: rs.fn() };
    const call = await calls.call("core:helper", { prompt: "go" }, callingTurn(sessions));

    await call.cancel("stop");
    expect(child.session.stop).toHaveBeenCalledWith("stop");
    wait.open();
    await call.outcome;
    await call.cancel("late");
    await stops[0]("late");
    expect(child.session.stop).toHaveBeenCalledTimes(1);
  });

  it("fails the call with the message of a stream that throws, and finishes the live turn", async () => {
    const { calls, finish } = setup({ chat: parentRow });
    const child = fakeSession("sub", async function* () {
      yield event({ type: "text", content: "working" });
      throw new Error("provider went away");
    });
    const sessions: SubagentSessions = { open: async () => child.session, resume: rs.fn() };
    const call = await calls.call("core:helper", { prompt: "go" }, callingTurn(sessions));
    await expect(call.outcome).resolves.toEqual({
      status: "failed",
      error: { message: "provider went away" },
    });
    await Promise.resolve();
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
