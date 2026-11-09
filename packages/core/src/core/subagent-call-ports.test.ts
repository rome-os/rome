import { ROOT_CONTEXT } from "@opentelemetry/api";
import { testTurnHandle } from "../test/turn-handle.js";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/db.js";
import type {
  AgentSession,
  AgentSessionManager,
  AgentTurnInput,
  SendTurnOptions,
} from "../agent/index.js";
import {
  createSubagentCalls,
  subagentRequest,
  WebChatDashboardSessions,
  type SubagentCalls,
} from "../agent/index.js";
import { subagentLiveTurns, subagentSessions, subagentTurnLog } from "./subagent-call-ports.js";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeChildSession(sessionId: string, turnIds: string[]) {
  const releases = turnIds.map(() => deferred());
  const calls: Array<{ input: AgentTurnInput; options?: SendTurnOptions }> = [];
  let turnIndex = 0;
  const interrupt = rs.fn(async () => {
    releases[Math.max(0, turnIndex - 1)]?.resolve();
  });
  const session: AgentSession = {
    selectModel: () => {},
    key: { agentName: "researcher", channelThreadKey: `subagent:${sessionId}` },
    sessionId,
    status: "idle",
    sendTurn(input, options) {
      const index = turnIndex++;
      const turnId = turnIds[index];
      calls.push({ input, options });
      const events: AsyncIterable<StreamAgentEvent> = {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "turn_start",
            sessionId,
            turnId,
            userPrompt: input.prompt,
            agent: "researcher",
          };
          yield { type: "text", content: "working", turnPhase: "commentary", agent: "researcher" };
          await releases[index].promise;
          yield { type: "result", content: `answer:${input.prompt}`, agent: "researcher" };
          yield {
            type: "turn_end",
            turnId,
            status: "completed",
            durationMs: 10,
            agent: "researcher",
          };
        },
      };
      return testTurnHandle({
        turnId,
        events,
        turnContext: ROOT_CONTEXT,
      });
    },
    submitInput: rs.fn(),
    runForkedTurn: rs.fn(),
    subscribe: () => () => undefined,
    onStatusChange: () => () => undefined,
    interrupt,
    close: rs.fn(async () => undefined),
  };
  return { session, releases, calls, interrupt };
}

describe("subagent calls through the run's ports", () => {
  let db: TestDb;
  let repo: WebChatRepository;
  let calls: SubagentCalls;
  // Starts a call from a calling turn whose subagent sessions open through
  // the core adapter, with the parent's session manager.
  const createService = () => ({
    startSubagent(
      name: string,
      input: unknown,
      context: {
        parentSessionId: string;
        parentAgentSessionId: string;
        parentTurnId: string;
        parentToolUseId: string;
        parentAgentName: string;
        parentChannelThreadKey: string;
        childManager: AgentSessionManager;
        workingDir: string;
      },
    ) {
      return calls.call(name, subagentRequest(input), {
        key: {
          dashboardSessionId: context.parentSessionId,
          turnId: context.parentTurnId,
          toolUseId: context.parentToolUseId,
        },
        agentName: context.parentAgentName,
        agentSessionId: context.parentAgentSessionId,
        sessions: subagentSessions(context.childManager, context.parentChannelThreadKey, repo),
        at: { workingDir: context.workingDir },
      });
    },
  });

  beforeEach(async () => {
    db = createTestDb();
    repo = new ChatsWebChatRepository(db.db);
    calls = createSubagentCalls({
      dashboard: new WebChatDashboardSessions(repo),
      turnLog: subagentTurnLog(repo),
      liveTurns: subagentLiveTurns(createAgentTurnStreamRegistry()),
    });
    await repo.ensureRomeSession({
      id: "parent-1",
      type: "webchat",
      name: "Parent",
      agentName: null,
      projectName: "project-a",
      projectPath: "project-a",
    });
    await repo.ensureRomeSession({
      id: "parent-2",
      type: "webchat",
      name: "Other Parent",
      agentName: null,
      projectName: "project-a",
      projectPath: "project-a",
    });
  });

  afterEach(() => db.close());

  it("returns stable IDs before completion, creates fresh sessions, and persists Child-owned text", async () => {
    const first = fakeChildSession("child-1", ["child-turn-1"]);
    const second = fakeChildSession("child-2", ["child-turn-2"]);
    const children = [first.session, second.session];
    const recordSessionInChat = rs.spyOn(repo, "recordSessionInChat");
    const childManager = {
      acquire: rs.fn(async () => children.shift()!),
      acquireBySessionId: rs.fn(),
      peek: rs.fn(),
      shutdown: rs.fn(async () => undefined),
    } as unknown as AgentSessionManager;
    const service = createService();
    const parent = {
      parentSessionId: "parent-1",
      parentAgentSessionId: "parent-runtime-1",
      parentTurnId: "parent-turn-1",
      parentToolUseId: "tool-1",
      parentAgentName: "main",
      parentChannelThreadKey: "webchat:parent-1",
      childManager,
      workingDir: "/tmp/project-a",
    };
    const callKey = {
      dashboardSessionId: "parent-1",
      turnId: "parent-turn-1",
      toolUseId: "tool-1",
    };

    const execution1 = await service.startSubagent("researcher", { prompt: "one" }, parent);
    expect(execution1).toMatchObject({
      sessionId: "child-1",
      turnId: "child-turn-1",
      subagent: "researcher",
    });
    expect(first.calls[0].options?.lifecycleParent).toEqual({
      sessionId: "parent-runtime-1",
      turnId: "parent-turn-1",
      agentName: "main",
    });
    let completed = false;
    void execution1.outcome.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    first.releases[0].resolve();
    await expect(execution1.outcome).resolves.toEqual({
      status: "completed",
      output: "answer:one",
    });
    // Completion alone does not forget the call. The Parent forgets it only
    // after its ordinary tool_result has been persisted.
    expect(calls.forget(callKey)).toBe(true);
    await execution1.cancel("late Parent interrupt");
    expect(first.interrupt).not.toHaveBeenCalled();

    const execution2 = await service.startSubagent(
      "researcher",
      { prompt: "two" },
      { ...parent, parentToolUseId: "tool-2" },
    );
    expect(execution2.sessionId).toBe("child-2");
    expect(execution2.sessionId).not.toBe(execution1.sessionId);
    second.releases[0].resolve();
    await execution2.outcome;

    const childMessages = await repo.getMessages("child-1");
    expect(childMessages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(childMessages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(childMessages.filter((message) => message.role === "trace")).toHaveLength(1);
    const childTrace = await repo.getTraceContents("child-1");
    expect(childTrace.some((message) => message.content.includes("working"))).toBe(true);
    await expect(repo.getSession("child-1")).resolves.toMatchObject({ type: "subagent" });
    await expect(repo.getSession("child-2")).resolves.toMatchObject({ type: "subagent" });
    expect(recordSessionInChat.mock.calls).toEqual([
      ["child-1", "child-1"],
      ["child-2", "child-2"],
    ]);
    const homeChats = await repo.listSessions();
    expect(homeChats.map((session) => session.id)).not.toContain("child-1");
    expect(homeChats.map((session) => session.id)).not.toContain("child-2");
  });

  it("still runs a fresh Child when recording the chat that has its session fails", async () => {
    const child = fakeChildSession("child-unrecorded", ["child-turn"]);
    rs.spyOn(repo, "recordSessionInChat").mockRejectedValue(new Error("database is locked"));
    const childManager = {
      acquire: rs.fn(async () => child.session),
      acquireBySessionId: rs.fn(),
      peek: rs.fn(),
      shutdown: rs.fn(async () => undefined),
    } as unknown as AgentSessionManager;
    const service = createService();

    const execution = await service.startSubagent(
      "researcher",
      { prompt: "one" },
      {
        parentSessionId: "parent-1",
        parentAgentSessionId: "parent-runtime-1",
        parentTurnId: "parent-turn-1",
        parentToolUseId: "tool-1",
        parentAgentName: "main",
        parentChannelThreadKey: "webchat:parent-1",
        childManager,
        workingDir: "/tmp/project-a",
      },
    );
    child.releases[0].resolve();

    expect(execution.sessionId).toBe("child-unrecorded");
    await expect(execution.outcome).resolves.toMatchObject({
      status: "completed",
      output: "answer:one",
    });
  });

  it("makes no Child when its Parent is deleted while the Child is being opened", async () => {
    const child = fakeChildSession("child-orphan", ["child-turn"]);
    const childManager = {
      // The Parent goes while the Child's runtime opens.
      acquire: rs.fn(async () => {
        await repo.deleteSession("parent-1");
        return child.session;
      }),
      acquireBySessionId: rs.fn(),
      peek: rs.fn(),
      shutdown: rs.fn(async () => undefined),
    } as unknown as AgentSessionManager;
    const service = createService();
    await expect(
      service.startSubagent(
        "researcher",
        { prompt: "one" },
        {
          parentSessionId: "parent-1",
          parentAgentSessionId: "parent-runtime-1",
          parentTurnId: "parent-turn-1",
          parentToolUseId: "tool-1",
          parentAgentName: "main",
          parentChannelThreadKey: "webchat:parent-1",
          childManager,
          workingDir: "/tmp/project-a",
        },
      ),
    ).rejects.toThrow("was not found");
    // No row without the owner and privacy it would have taken from its Parent.
    await expect(repo.getSession("child-orphan")).resolves.toBeNull();
  });

  it("resumes only an existing Child owned by the same Parent", async () => {
    await repo.ensureRomeSession({
      id: "child-resume",
      type: "subagent",
      name: "researcher: Parent",
      agentName: "researcher",
      projectName: "project-a",
      projectPath: "project-a",
      parentSessionId: "parent-1",
      parentTurnId: "original-parent-turn",
    });
    const resumed = fakeChildSession("child-resume", ["resumed-turn"]);
    const recordSessionInChat = rs.spyOn(repo, "recordSessionInChat");
    const childManager = {
      acquire: rs.fn(),
      acquireBySessionId: rs.fn(async () => resumed.session),
      peek: rs.fn(),
      shutdown: rs.fn(async () => undefined),
    } as unknown as AgentSessionManager;
    const service = createService();
    const context = {
      parentSessionId: "parent-1",
      parentAgentSessionId: "parent-runtime-1",
      parentTurnId: "new-parent-turn",
      parentToolUseId: "tool-resume",
      parentAgentName: "main",
      parentChannelThreadKey: "webchat:parent-1",
      childManager,
      workingDir: "/tmp/project-a",
    };

    const execution = await service.startSubagent(
      "researcher",
      { prompt: "continue", resumeSessionId: "child-resume" },
      context,
    );
    expect(execution).toMatchObject({ sessionId: "child-resume", turnId: "resumed-turn" });
    expect(childManager.acquireBySessionId).toHaveBeenCalledWith(
      "child-resume",
      "researcher",
      expect.anything(),
    );
    expect(recordSessionInChat).toHaveBeenCalledWith("child-resume", "child-resume", {
      replace: true,
    });
    resumed.releases[0].resolve();
    await execution.outcome;

    await expect(
      service.startSubagent(
        "researcher",
        { prompt: "steal", resumeSessionId: "child-resume" },
        { ...context, parentSessionId: "parent-2", parentToolUseId: "tool-other" },
      ),
    ).rejects.toThrow(/different Parent session/);

    await repo.deleteSession("parent-1");
    await expect(repo.getSession("child-resume")).resolves.toMatchObject({
      id: "child-resume",
      parentSessionId: "parent-1",
    });
    await expect(
      service.startSubagent(
        "researcher",
        { prompt: "continue", resumeSessionId: "child-resume" },
        { ...context, parentToolUseId: "tool-after-delete" },
      ),
    ).rejects.toThrow(/Parent Rome session.*was not found/);
  });
});
