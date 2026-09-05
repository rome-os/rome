import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ChildSessionCaller,
  DetachedChildParent,
  RomeSessionType,
} from "@rome-os/app-runtime";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { AgentSessionManager } from "./agent-session.js";
import {
  createAgentTurnStreamRegistry,
  type AgentTurnStreamRegistry,
} from "./agent-turn-stream-registry.js";
import {
  createDetachedSubagentService,
  DETACHED_SHUTDOWN_GRACE_MS,
  MAX_LIVE_DETACHED_CHILDREN,
  MAX_LIVE_DETACHED_CHILDREN_PER_PARENT,
  type DetachedSubagentService,
} from "./detached-subagent-service.js";
import type {
  StartSubagentContext,
  SubagentCompletion,
  SubagentExecution,
  SubagentExecutionService,
} from "./subagent-execution.js";

const PARENT: DetachedChildParent = {
  parentSessionId: "parent-1",
  parentTurnId: "parent-turn-1",
  parentAgentName: "main",
};
const CALLER: ChildSessionCaller = { romeSessionId: "parent-1", agentName: "main" };

/** Drains the microtask queue so continuations queued behind an already
 * resolved promise have run. Fake timers do not advance microtasks. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Stands in for the real service: registers a turn stream (so the live-child
 * checks see it) and hands back a completion the test settles when it wants to.
 * `interrupts` records what a stop or a shutdown asked for. */
function fakeSubagents(turnStreams: AgentTurnStreamRegistry) {
  const contexts: StartSubagentContext[] = [];
  const finishers: Array<() => void> = [];
  const completers: Array<() => void> = [];
  const interrupts: string[] = [];
  let next = 0;
  const service: SubagentExecutionService = {
    async startSubagent(name, input, context) {
      contexts.push(context);
      const sessionId = input.resumeSessionId ?? `child-${++next}`;
      const turnId = `${sessionId}-turn-${contexts.length}`;
      const interrupt = async (reason?: string) => {
        interrupts.push(reason ?? "");
      };
      const stream = turnStreams.register({ sessionId, turnId, agentName: name, interrupt });
      finishers.push(() => stream.finish());
      let resolveCompletion!: (completion: SubagentCompletion) => void;
      const completion = new Promise<SubagentCompletion>((resolve) => {
        resolveCompletion = resolve;
      });
      completers.push(() => {
        stream.finish();
        resolveCompletion({ status: "completed", sessionId, turnId, output: "" });
      });
      return {
        sessionId,
        turnId,
        agentName: name,
        events: { async *[Symbol.asyncIterator]() {} },
        completion,
        interrupt,
      } satisfies SubagentExecution;
    },
  };
  return { service, contexts, finishers, completers, interrupts };
}

describe("DetachedSubagentService", () => {
  let db: TestDb;
  let repo: WebChatRepository;
  let turnStreams: AgentTurnStreamRegistry;
  let subagents: ReturnType<typeof fakeSubagents>;
  let service: DetachedSubagentService;
  let managerShutdowns: number;
  let detachedManager: AgentSessionManager;

  async function makeSession(
    id: string,
    overrides: {
      type?: RomeSessionType;
      agentName?: string | null;
      parentSessionId?: string;
      projectPath?: string;
    } = {},
  ) {
    await repo.ensureRomeSession({
      id,
      type: overrides.type ?? "action",
      name: id,
      agentName: overrides.agentName ?? null,
      ...(overrides.projectPath ? { projectPath: overrides.projectPath } : {}),
      ...(overrides.parentSessionId
        ? {
            parentSessionId: overrides.parentSessionId,
            parentTurnId: `${overrides.parentSessionId}-turn`,
          }
        : {}),
    });
  }

  beforeEach(async () => {
    db = createTestDb();
    repo = new WebChatRepository(db.db);
    turnStreams = createAgentTurnStreamRegistry();
    subagents = fakeSubagents(turnStreams);
    managerShutdowns = 0;
    detachedManager = {
      shutdown: async () => {
        managerShutdowns += 1;
      },
    } as unknown as AgentSessionManager;
    service = createDetachedSubagentService({
      webchatRepo: repo,
      subagents: subagents.service,
      turnStreams,
      detachedManager,
      resolveDefaultWorkingDir: async () => "/tmp/default",
    });
    await repo.ensureRomeSession({
      id: "parent-1",
      type: "webchat",
      name: "Parent",
      agentName: null,
      projectName: "project-a",
      projectPath: "/tmp/project-a",
    });
  });

  afterEach(() => {
    rs.useRealTimers();
    db.close();
  });

  describe("startDetached", () => {
    it("returns ids without waiting for the child to finish", async () => {
      const started = await service.startDetached({
        agentName: "researcher",
        prompt: "go",
        parent: PARENT,
      });

      expect(started).toEqual({
        sessionId: "child-1",
        turnId: "child-1-turn-1",
        agentName: "researcher",
        parentSessionId: "parent-1",
      });
      // The fake never settles its completion, so resolving at all proves
      // nothing here awaited it.
      expect(subagents.contexts[0]).toMatchObject({
        detached: true,
        parentSessionId: "parent-1",
        parentAgentSessionId: "parent-1",
        parentTurnId: "parent-turn-1",
        parentAgentName: "main",
        parentChannelThreadKey: "detached:parent-1",
        childManager: detachedManager,
        workingDir: "/tmp/project-a",
      });
      expect(subagents.contexts[0]!.childProjectPath).toBeUndefined();
      expect(subagents.contexts[0]!.parentToolUseId).toMatch(/^detached:/);
    });

    it("falls back to the default working dir when the parent has no project", async () => {
      await makeSession("parent-nodir");
      await service.startDetached({
        agentName: "researcher",
        prompt: "go",
        parent: { ...PARENT, parentSessionId: "parent-nodir" },
      });

      expect(subagents.contexts[0]!.workingDir).toBe("/tmp/default");
    });

    it("runs the child in an explicit workingDir and files it under that project", async () => {
      // A manager agent on a routine has no project of its own, so the
      // directory the child works in has to come from the call.
      await makeSession("tick-1", { agentName: "engineer:engineer" });

      await service.startDetached({
        agentName: "coding:coding",
        prompt: "go",
        workingDir: "/srv/clones/rome",
        parent: {
          parentSessionId: "tick-1",
          parentTurnId: "tick-1-turn",
          parentAgentName: "engineer:engineer",
        },
      });

      expect(subagents.contexts[0]).toMatchObject({
        workingDir: "/srv/clones/rome",
        childProjectPath: "/srv/clones/rome",
      });
    });

    it("refuses a workingDir that is not absolute", async () => {
      await expect(
        service.startDetached({
          agentName: "researcher",
          prompt: "go",
          workingDir: "clones/rome",
          parent: PARENT,
        }),
      ).rejects.toThrow(/absolute path/);
      expect(subagents.contexts).toHaveLength(0);
    });

    it("refuses a caller that is not an agent turn", async () => {
      await expect(
        service.startDetached({ agentName: "researcher", prompt: "go" }),
      ).rejects.toThrow(/agent-session caller/);
    });

    it("refuses a caller that is itself a child session", async () => {
      // Every child session carries type `subagent`, so this also stops a
      // detached child from fanning out detached children of its own.
      await makeSession("child-caller", { type: "subagent", parentSessionId: "parent-1" });

      await expect(
        service.startDetached({
          agentName: "researcher",
          prompt: "go",
          parent: { ...PARENT, parentSessionId: "child-caller" },
        }),
      ).rejects.toThrow(/cannot start detached children of its own/);
      expect(subagents.contexts).toHaveLength(0);
    });

    it("caps live children per parent and frees a slot when one finishes", async () => {
      for (let i = 0; i < MAX_LIVE_DETACHED_CHILDREN_PER_PARENT; i++) {
        await service.startDetached({ agentName: "researcher", prompt: "go", parent: PARENT });
      }

      await expect(
        service.startDetached({ agentName: "researcher", prompt: "one more", parent: PARENT }),
      ).rejects.toThrow(/limit 8/);

      // A different parent has its own budget.
      await makeSession("parent-2");
      await service.startDetached({
        agentName: "researcher",
        prompt: "go",
        parent: { ...PARENT, parentSessionId: "parent-2" },
      });

      subagents.finishers[0]!();
      await service.startDetached({ agentName: "researcher", prompt: "one more", parent: PARENT });
      expect(subagents.contexts).toHaveLength(MAX_LIVE_DETACHED_CHILDREN_PER_PARENT + 2);
    });

    it("caps live children process-wide across parents", async () => {
      // The per-parent cap bounds nothing over time: a manager agent on a
      // schedule gets a fresh session every run, and a fresh session starts with
      // an empty per-parent budget.
      const parents = MAX_LIVE_DETACHED_CHILDREN / MAX_LIVE_DETACHED_CHILDREN_PER_PARENT;
      for (let p = 0; p < parents; p++) {
        await makeSession(`tick-${p}`);
        for (let i = 0; i < MAX_LIVE_DETACHED_CHILDREN_PER_PARENT; i++) {
          await service.startDetached({
            agentName: "researcher",
            prompt: "go",
            parent: { ...PARENT, parentSessionId: `tick-${p}` },
          });
        }
      }
      await makeSession("tick-fresh");

      await expect(
        service.startDetached({
          agentName: "researcher",
          prompt: "one more",
          parent: { ...PARENT, parentSessionId: "tick-fresh" },
        }),
      ).rejects.toThrow(new RegExp(`limit ${MAX_LIVE_DETACHED_CHILDREN}`));

      subagents.finishers[0]!();
      await service.startDetached({
        agentName: "researcher",
        prompt: "one more",
        parent: { ...PARENT, parentSessionId: "tick-fresh" },
      });
      expect(subagents.contexts).toHaveLength(MAX_LIVE_DETACHED_CHILDREN + 1);
    });

    it("stops tracking a child once its completion settles", async () => {
      const started = await service.startDetached({
        agentName: "researcher",
        prompt: "go",
        parent: PARENT,
      });

      subagents.completers[0]!();
      await flushMicrotasks();

      // The parent's whole budget is free again, which it would not be if the
      // finished child were still tracked.
      for (let i = 0; i < MAX_LIVE_DETACHED_CHILDREN_PER_PARENT; i++) {
        await service.startDetached({ agentName: "researcher", prompt: "go", parent: PARENT });
      }
      expect(started.sessionId).toBe("child-1");
      expect(subagents.contexts).toHaveLength(MAX_LIVE_DETACHED_CHILDREN_PER_PARENT + 1);
    });
  });

  describe("startDetached resume", () => {
    beforeEach(async () => {
      await makeSession("tick-1", { agentName: "engineer:engineer" });
      await makeSession("tick-2", { agentName: "engineer:engineer" });
      await makeSession("other-tick", { agentName: "briefing:briefing" });
    });

    const tick2: DetachedChildParent = {
      parentSessionId: "tick-2",
      parentTurnId: "tick-2-turn",
      parentAgentName: "engineer:engineer",
    };

    async function makeChild(
      id: string,
      parentSessionId: string,
      projectPath?: string,
    ): Promise<void> {
      await makeSession(id, {
        type: "subagent",
        agentName: "coding:coding",
        parentSessionId,
        ...(projectPath ? { projectPath } : {}),
      });
    }

    it("resumes a child of an earlier session of the same agent, keeping its lineage", async () => {
      await makeChild("child-x", "tick-1");

      const resumed = await service.startDetached({
        agentName: "coding:coding",
        prompt: "keep going",
        resumeSessionId: "child-x",
        parent: tick2,
      });

      expect(resumed.parentSessionId).toBe("tick-1");
      expect(subagents.contexts[0]).toMatchObject({
        // `startSubagent` insists a resumed child is handed the parent it is
        // already filed under, so the lineage stays put while the caller moves.
        parentSessionId: "tick-1",
        parentAgentSessionId: "tick-2",
        parentTurnId: "tick-2-turn",
        parentChannelThreadKey: "detached:tick-1",
      });
    });

    it("resumes into the directory the child already works in", async () => {
      await makeChild("child-x", "tick-1", "/srv/clones/rome");

      await service.startDetached({
        agentName: "coding:coding",
        prompt: "keep going",
        resumeSessionId: "child-x",
        parent: tick2,
      });

      expect(subagents.contexts[0]!.workingDir).toBe("/srv/clones/rome");
      expect(subagents.contexts[0]!.childProjectPath).toBeUndefined();
    });

    it("refuses a resume that would move the child to another directory", async () => {
      await makeChild("child-x", "tick-1", "/srv/clones/rome");

      await expect(
        service.startDetached({
          agentName: "coding:coding",
          prompt: "keep going",
          resumeSessionId: "child-x",
          workingDir: "/srv/clones/other",
          parent: tick2,
        }),
      ).rejects.toThrow(/cannot move it/);
    });

    it("rejects a child that is still running", async () => {
      await makeChild("child-x", "tick-1");
      await service.startDetached({
        agentName: "coding:coding",
        prompt: "go",
        resumeSessionId: "child-x",
        parent: tick2,
      });

      await expect(
        service.startDetached({
          agentName: "coding:coding",
          prompt: "again",
          resumeSessionId: "child-x",
          parent: tick2,
        }),
      ).rejects.toThrow("child is still running");

      subagents.finishers[0]!();
      await service.startDetached({
        agentName: "coding:coding",
        prompt: "again",
        resumeSessionId: "child-x",
        parent: tick2,
      });
      expect(subagents.contexts).toHaveLength(2);
    });

    it.each([
      ["another agent's child", "child-other"],
      ["a session that is not a child", "parent-1"],
      ["an id no session carries", "nope"],
    ])("refuses to resume %s with the same message", async (_label, sessionId) => {
      // Ownership is decided before liveness, and every refusal reads the same,
      // so a caller cannot probe for children it does not own.
      await makeChild("child-other", "other-tick");

      await expect(
        service.startDetached({
          agentName: "coding:coding",
          prompt: "keep going",
          resumeSessionId: sessionId,
          parent: tick2,
        }),
      ).rejects.toThrow(/belongs to this agent/);
      expect(subagents.contexts).toHaveLength(0);
    });

    it("decides ownership before liveness", async () => {
      await makeChild("child-other", "other-tick");
      await service.startDetached({
        agentName: "coding:coding",
        prompt: "go",
        resumeSessionId: "child-other",
        parent: {
          parentSessionId: "other-tick",
          parentTurnId: "other-tick-turn",
          parentAgentName: "briefing:briefing",
        },
      });

      // The child is running, but a caller from another agent must not learn
      // that from the error.
      await expect(
        service.startDetached({
          agentName: "coding:coding",
          prompt: "keep going",
          resumeSessionId: "child-other",
          parent: tick2,
        }),
      ).rejects.toThrow(/belongs to this agent/);
    });
  });

  describe("getStatus", () => {
    async function recordTurn(
      sessionId: string,
      turnId: string,
      options: {
        at: string;
        prompt: string;
        reply?: string;
        turnEnd?: "completed" | "error" | "interrupted";
        error?: string;
      },
    ) {
      rs.setSystemTime(new Date(options.at));
      const blocks: unknown[] = [{ type: "turn_start", turnId, userPrompt: options.prompt }];
      if (options.reply !== undefined) blocks.push({ type: "result", content: options.reply });
      if (options.error !== undefined) blocks.push({ type: "error", error: options.error });
      if (options.turnEnd) blocks.push({ type: "turn_end", turnId, status: options.turnEnd });
      await repo.appendTraceBlocks({
        messageId: `trace:${sessionId}:${turnId}`,
        sessionId,
        turnId,
        startSeq: 0,
        blocks,
        transcriptMessages: [
          {
            id: `transcript:${sessionId}:${turnId}:user`,
            sessionId,
            role: "user",
            content: JSON.stringify([{ type: "text", content: options.prompt }]),
            turnId,
          },
          ...(options.reply !== undefined
            ? [
                {
                  id: `transcript:${sessionId}:${turnId}:assistant`,
                  sessionId,
                  role: "assistant" as const,
                  content: JSON.stringify([{ type: "text", content: options.reply }]),
                  turnId,
                },
              ]
            : []),
        ],
      });
    }

    async function makeChild(sessionId: string) {
      await repo.ensureRomeSession({
        id: sessionId,
        type: "subagent",
        name: "researcher: Parent",
        agentName: "researcher",
        parentSessionId: "parent-1",
        parentTurnId: "parent-turn-1",
      });
    }

    beforeEach(() => {
      rs.useFakeTimers();
      rs.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    });

    it("returns null for an id no session carries", async () => {
      await expect(service.getStatus({ sessionId: "nope", caller: CALLER })).resolves.toBeNull();
    });

    it("returns null for a session that is not a child session", async () => {
      // The parent's own webchat session exists and the caller owns it, but it
      // is not a child, so its transcript is not readable through here.
      await expect(
        service.getStatus({ sessionId: "parent-1", caller: CALLER }),
      ).resolves.toBeNull();
    });

    it("returns null for a child of another agent", async () => {
      await makeSession("other-tick", { agentName: "briefing:briefing" });
      await makeSession("child-other", {
        type: "subagent",
        agentName: "coding:coding",
        parentSessionId: "other-tick",
      });

      await expect(
        service.getStatus({
          sessionId: "child-other",
          caller: { romeSessionId: "parent-1", agentName: "main" },
        }),
      ).resolves.toBeNull();
    });

    it("reads a child started by an earlier session of the same agent", async () => {
      // The cross-tick case: a manager agent on a schedule gets a fresh session
      // every run, so the run that reads a child is never the run that started
      // it.
      await makeSession("tick-1", { agentName: "engineer:engineer" });
      await makeSession("tick-2", { agentName: "engineer:engineer" });
      await makeSession("child-x", {
        type: "subagent",
        agentName: "coding:coding",
        parentSessionId: "tick-1",
      });
      await recordTurn("child-x", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "go",
        reply: "the answer",
        turnEnd: "completed",
      });

      await expect(
        service.getStatus({
          sessionId: "child-x",
          caller: { romeSessionId: "tick-2", agentName: "engineer:engineer" },
        }),
      ).resolves.toMatchObject({
        status: "completed",
        reply: "the answer",
        parentSessionId: "tick-1",
      });
    });

    it("refuses a read that no agent turn made", async () => {
      await makeChild("child-idle");

      await expect(service.getStatus({ sessionId: "child-idle" })).rejects.toThrow(
        /agent-session caller/,
      );
    });

    it("reports running off the live stream, ahead of any recorded outcome", async () => {
      const started = await service.startDetached({
        agentName: "researcher",
        prompt: "go",
        parent: PARENT,
      });
      await makeChild(started.sessionId);
      await recordTurn(started.sessionId, "stale-turn", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "earlier",
        reply: "earlier answer",
        turnEnd: "completed",
      });

      await expect(
        service.getStatus({ sessionId: started.sessionId, caller: CALLER }),
      ).resolves.toMatchObject({
        status: "running",
        turnId: started.turnId,
        reply: null,
        error: null,
        agentName: "researcher",
        parentSessionId: "parent-1",
      });
    });

    it.each([
      ["completed", "completed"],
      ["error", "failed"],
      ["interrupted", "interrupted"],
    ] as const)("maps a %s turn_end to %s", async (turnEnd, expected) => {
      await makeChild("child-mapped");
      await recordTurn("child-mapped", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "go",
        reply: "the answer",
        turnEnd,
        ...(turnEnd === "error" ? { error: "model refused" } : {}),
      });

      await expect(
        service.getStatus({ sessionId: "child-mapped", caller: CALLER }),
      ).resolves.toMatchObject({
        status: expected,
        turnId: "turn-1",
        reply: "the answer",
        error: turnEnd === "error" ? "model refused" : null,
      });
    });

    it("reports the newest turn when two land in the same second", async () => {
      // createdAt stores whole seconds, so back-to-back turns tie on it and the
      // outcome has to be read off insertion order instead.
      await makeChild("child-fast");
      await recordTurn("child-fast", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "first",
        reply: "first answer",
        turnEnd: "completed",
      });
      await recordTurn("child-fast", "turn-2", {
        at: "2030-01-01T00:00:00.500Z",
        prompt: "second",
        reply: "second answer",
        turnEnd: "error",
        error: "model refused",
      });

      await expect(
        service.getStatus({ sessionId: "child-fast", caller: CALLER }),
      ).resolves.toMatchObject({
        status: "failed",
        turnId: "turn-2",
        reply: "second answer",
        error: "model refused",
      });
    });

    it("reports interrupted for a turn that opened and never closed", async () => {
      await makeChild("child-cut");
      await recordTurn("child-cut", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "go",
      });

      await expect(
        service.getStatus({ sessionId: "child-cut", caller: CALLER }),
      ).resolves.toMatchObject({
        status: "interrupted",
        turnId: "turn-1",
        reply: null,
      });
    });

    it("reports unknown for a session that has run no turn", async () => {
      await makeChild("child-idle");

      await expect(
        service.getStatus({ sessionId: "child-idle", caller: CALLER }),
      ).resolves.toMatchObject({
        status: "unknown",
        turnId: null,
        reply: null,
        error: null,
      });
    });

    it("omits the transcript unless asked and clamps the tail at 50", async () => {
      await makeChild("child-tail");
      await recordTurn("child-tail", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "one",
        reply: "answer one",
        turnEnd: "completed",
      });
      await recordTurn("child-tail", "turn-2", {
        at: "2030-01-01T01:00:00.000Z",
        prompt: "two",
        reply: "answer two",
        turnEnd: "completed",
      });

      await expect(
        service.getStatus({ sessionId: "child-tail", caller: CALLER }),
      ).resolves.not.toHaveProperty("transcript");
      await expect(
        service.getStatus({ sessionId: "child-tail", transcriptTail: 0, caller: CALLER }),
      ).resolves.not.toHaveProperty("transcript");

      const tailed = await service.getStatus({
        sessionId: "child-tail",
        transcriptTail: 3,
        caller: CALLER,
      });
      expect(tailed?.transcript).toEqual([
        {
          role: "assistant",
          turnId: "turn-1",
          text: "answer one",
          createdAt: "2030-01-01T00:00:00.000Z",
        },
        { role: "user", turnId: "turn-2", text: "two", createdAt: "2030-01-01T01:00:00.000Z" },
        {
          role: "assistant",
          turnId: "turn-2",
          text: "answer two",
          createdAt: "2030-01-01T01:00:00.000Z",
        },
      ]);

      const overAsked = await service.getStatus({
        sessionId: "child-tail",
        transcriptTail: 9999,
        caller: CALLER,
      });
      expect(overAsked?.transcript).toHaveLength(4);
    });
  });

  describe("stop", () => {
    it("interrupts a running child", async () => {
      const started = await service.startDetached({
        agentName: "researcher",
        prompt: "go",
        parent: PARENT,
      });
      await repo.ensureRomeSession({
        id: started.sessionId,
        type: "subagent",
        name: "researcher",
        agentName: "researcher",
        parentSessionId: "parent-1",
        parentTurnId: "parent-turn-1",
      });

      await expect(service.stop({ sessionId: started.sessionId, caller: CALLER })).resolves.toEqual(
        { stopped: true, status: "running" },
      );
      expect(subagents.interrupts).toEqual(["stopped by the summoning agent"]);
    });

    it("reports the status and changes nothing when no turn is running", async () => {
      await repo.ensureRomeSession({
        id: "child-done",
        type: "subagent",
        name: "researcher",
        agentName: "researcher",
        parentSessionId: "parent-1",
        parentTurnId: "parent-turn-1",
      });

      await expect(service.stop({ sessionId: "child-done", caller: CALLER })).resolves.toEqual({
        stopped: false,
        status: "unknown",
      });
      expect(subagents.interrupts).toEqual([]);
    });

    it("returns null for a child the caller's agent does not own", async () => {
      await makeSession("other-tick", { agentName: "briefing:briefing" });
      await makeSession("child-other", {
        type: "subagent",
        agentName: "coding:coding",
        parentSessionId: "other-tick",
      });

      await expect(service.stop({ sessionId: "child-other", caller: CALLER })).resolves.toBeNull();
      await expect(service.stop({ sessionId: "parent-1", caller: CALLER })).resolves.toBeNull();
      expect(subagents.interrupts).toEqual([]);
    });
  });

  describe("shutdown", () => {
    it("interrupts live children before closing the manager they run under", async () => {
      await service.startDetached({ agentName: "researcher", prompt: "go", parent: PARENT });
      await service.startDetached({ agentName: "researcher", prompt: "go", parent: PARENT });

      await service.shutdown();

      expect(subagents.interrupts).toEqual(["shutdown", "shutdown"]);
      expect(managerShutdowns).toBe(1);
    });

    it("gives up on a manager that will not close, so the process can exit", async () => {
      // A provider wedged mid-turn would otherwise hold the close open for as
      // long as it likes.
      rs.useFakeTimers();
      service = createDetachedSubagentService({
        webchatRepo: repo,
        subagents: subagents.service,
        turnStreams,
        detachedManager: { shutdown: () => new Promise<void>(() => {}) } as AgentSessionManager,
        resolveDefaultWorkingDir: async () => "/tmp/default",
      });
      await service.startDetached({ agentName: "researcher", prompt: "go", parent: PARENT });

      let settled = false;
      const done = service.shutdown().then(() => {
        settled = true;
      });
      await flushMicrotasks();
      expect(settled).toBe(false);

      rs.advanceTimersByTime(DETACHED_SHUTDOWN_GRACE_MS);
      await done;
      expect(settled).toBe(true);
      expect(subagents.interrupts).toEqual(["shutdown"]);
    });
  });
});
