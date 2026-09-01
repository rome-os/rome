import { ROOT_CONTEXT } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type {
  AgentSession,
  AgentSessionManager,
  AgentTurnInput,
  SendTurnOptions,
  StreamAgentMessage,
} from "./agent-session.js";
import { createActiveSubagentRegistry } from "./active-subagent-registry.js";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { createSubagentExecutionService } from "./subagent-execution.js";

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
    key: { agentName: "researcher", channelThreadKey: `subagent:${sessionId}` },
    sessionId,
    status: "idle",
    sendTurn(input, options) {
      const index = turnIndex++;
      const turnId = turnIds[index];
      calls.push({ input, options });
      const events: AsyncIterable<StreamAgentMessage> = {
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
      return {
        turnId,
        events,
        turnContext: ROOT_CONTEXT,
      };
    },
    subscribe: () => () => undefined,
    onStatusChange: () => () => undefined,
    interrupt,
    close: rs.fn(async () => undefined),
  };
  return { session, releases, calls, interrupt };
}

describe("SubagentExecutionService", () => {
  let db: TestDb;
  let repo: WebChatRepository;

  beforeEach(async () => {
    db = createTestDb();
    repo = new WebChatRepository(db.db);
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
    const childManager = {
      acquire: rs.fn(async () => children.shift()!),
      acquireBySessionId: rs.fn(),
      peek: rs.fn(),
      shutdown: rs.fn(async () => undefined),
    } as unknown as AgentSessionManager;
    const registry = createActiveSubagentRegistry();
    const service = createSubagentExecutionService({
      webchatRepo: repo,
      activeRegistry: registry,
      turnStreams: createAgentTurnStreamRegistry(),
    });
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
    const parentRef = { sessionId: "parent-1", turnId: "parent-turn-1", toolUseId: "tool-1" };

    const execution1 = await service.startSubagent("researcher", { prompt: "one" }, parent);
    expect(execution1).toMatchObject({
      sessionId: "child-1",
      turnId: "child-turn-1",
      agentName: "researcher",
    });
    expect(first.calls[0].options?.lifecycleParent).toEqual({
      sessionId: "parent-runtime-1",
      turnId: "parent-turn-1",
      agentName: "main",
    });
    expect(registry.getLinkByParent(parentRef)?.child).toEqual({
      sessionId: "child-1",
      turnId: "child-turn-1",
    });
    let completed = false;
    void execution1.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    first.releases[0].resolve();
    await expect(execution1.completion).resolves.toEqual({
      status: "completed",
      sessionId: "child-1",
      turnId: "child-turn-1",
      output: "answer:one",
    });
    // Completion alone does not clear the active mapping. The Parent clears it
    // only after its ordinary tool_result has been persisted.
    expect(registry.getLinkByParent(parentRef)).toBeDefined();
    await execution1.interrupt("late Parent interrupt");
    expect(first.interrupt).not.toHaveBeenCalled();

    const execution2 = await service.startSubagent(
      "researcher",
      { prompt: "two" },
      { ...parent, parentToolUseId: "tool-2" },
    );
    expect(execution2.sessionId).toBe("child-2");
    expect(execution2.sessionId).not.toBe(execution1.sessionId);
    second.releases[0].resolve();
    await execution2.completion;

    const childMessages = await repo.getMessages("child-1");
    expect(childMessages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(childMessages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(childMessages.filter((message) => message.role === "trace")).toHaveLength(1);
    const childTrace = await repo.getTraceContents("child-1");
    expect(childTrace.some((message) => message.content.includes("working"))).toBe(true);
    await expect(repo.getSession("child-1")).resolves.toMatchObject({ type: "subagent" });
    await expect(repo.getSession("child-2")).resolves.toMatchObject({ type: "subagent" });
    const homeChats = await repo.listSessions();
    expect(homeChats.map((session) => session.id)).not.toContain("child-1");
    expect(homeChats.map((session) => session.id)).not.toContain("child-2");
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
    const childManager = {
      acquire: rs.fn(),
      acquireBySessionId: rs.fn(async () => resumed.session),
      peek: rs.fn(),
      shutdown: rs.fn(async () => undefined),
    } as unknown as AgentSessionManager;
    const service = createSubagentExecutionService({
      webchatRepo: repo,
      activeRegistry: createActiveSubagentRegistry(),
      turnStreams: createAgentTurnStreamRegistry(),
    });
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
      expect.any(Object),
    );
    resumed.releases[0].resolve();
    await execution.completion;

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
