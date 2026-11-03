import { afterEach, describe, expect, it } from "@rstest/core";
import type { ActionConfig, BackendTurnRunner } from "@rome-os/app-runtime";
import { createResumeSessionAction } from "../../../../rome_apps/system/src/actions/resume-session/index.js";
import { runDefer, type DeferContext } from "../core/defer.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import { EventBus } from "../events/event-bus.js";
import { systemClock } from "../lib/clock.js";
import { EventBusTriggerProvider } from "../routines/event-bus-trigger-provider.js";
import { RoutineEngine } from "../routines/engine.js";
import type { Trigger } from "../routines/types.js";
import { createTestRome, type TestRome } from "../test/kit/index.js";
import { createBackendTurnRunner } from "./backend-turn.js";

const resumeSessionConfig = {
  name: "resume_session",
  type: "system",
  description: "Continue an existing conversation",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "write",
} as ActionConfig;

describe("defer session continuity", () => {
  let rome: TestRome | undefined;

  afterEach(async () => {
    await rome?.cleanup();
    rome = undefined;
  });

  it("resumes the AgentSession that scheduled defer from a webchat key", async () => {
    rome = await createTestRome({ keepAliveAcrossTurns: true });

    const webchatSessionId = "deferring-chat";
    const webchatKey = `webchat:${webchatSessionId}`;
    const channelContext = {
      channel: "webchat",
      threadId: webchatSessionId,
      channelUserId: "guardian",
    };

    // This is the key shape the normal WebChat turn path uses.
    const initialMessages = await rome.runAgent({
      prompt: "Start work and check again later",
      channelThreadKey: webchatKey,
      threadContext: channelContext,
    });
    const initialSessionId = initialMessages.find(
      (message) => message.type === "session_init",
    )?.sessionId;
    expect(initialSessionId).toBeDefined();
    if (!initialSessionId) throw new Error("initial turn did not emit session_init");

    // Capture the one-off routine payload produced by the real defer logic,
    // then fire it through the real resume_session -> backend-turn chain.
    let routineArgs: Record<string, unknown> | undefined;
    const deferContext = {
      agentName: "main",
      sessionId: initialSessionId,
      channelContext,
    } satisfies DeferContext;
    await runDefer(
      { name: "deferred follow-up", afterMinutes: 1 },
      {
        context: deferContext,
        createRoutine: async (args) => {
          routineArgs = args;
          return { routineId: "defer-follow-up" };
        },
        now: Date.parse("2026-07-15T12:00:00.000Z"),
      },
    );

    const backendTurnRunner = createBackendTurnRunner({
      agentRunner: rome.agentRunner,
      channel: (name) => rome?.channels.find((channel) => channel.name === name) ?? null,
    });
    const resumeSession = createResumeSessionAction(resumeSessionConfig, {
      backendTurnRunner,
    } as never);
    const result = await resumeSession.execute(
      (routineArgs?.args ?? {}) as Record<string, unknown>,
    );
    expect(routineArgs?.args).not.toHaveProperty("channelThreadKey");
    expect(result.status).toBe("ok");

    const deferredSessionId = rome.model.sessions.at(-1)?.sessionId;
    const deferredSession = deferredSessionId
      ? await rome.repos.sessions.findById(deferredSessionId)
      : null;

    // Regression assertion: the continuation keeps the original runtime ID and
    // its session key instead of opening a second AgentSession.
    expect({
      sessionId: deferredSessionId,
      channelThreadKey: deferredSession?.channelThreadKey,
    }).toEqual({
      sessionId: initialSessionId,
      channelThreadKey: webchatKey,
    });
  });
  it("wakes the deferring session when the awaited event is published", async () => {
    // The routine fires resume_session through the real ActionEngine; the
    // action's orchestrator needs the runner, which exists only after boot.
    let runner: BackendTurnRunner | undefined;
    const resumeSession = createResumeSessionAction(resumeSessionConfig, {
      backendTurnRunner: {
        runAndDeliver: (params: Parameters<BackendTurnRunner["runAndDeliver"]>[0]) => {
          if (!runner) throw new Error("runner not wired");
          return runner.runAndDeliver(params);
        },
      },
    } as never);
    rome = await createTestRome({ keepAliveAcrossTurns: true, actions: [resumeSession] });
    const testRome = rome;
    runner = createBackendTurnRunner({
      agentRunner: testRome.agentRunner,
      channel: (name) => testRome.channels.find((channel) => channel.name === name) ?? null,
    });

    const channelContext = {
      channel: "webchat",
      threadId: "event-chat",
      channelUserId: "guardian",
    };
    const initial = await testRome.runAgent({
      prompt: "Watch CI and tell me when it finishes",
      channelThreadKey: "webchat:event-chat",
      threadContext: channelContext,
    });
    const sessionId = initial.find((message) => message.type === "session_init")?.sessionId;
    if (!sessionId) throw new Error("initial turn did not emit session_init");

    const routinesRepo = new RoutinesRepository(testRome.db);
    const routineEngine = new RoutineEngine(
      routinesRepo,
      new RoutineRunsRepository(testRome.db),
      testRome.actionEngine,
      0,
      systemClock,
    );
    const bus = new EventBus();
    const provider = new EventBusTriggerProvider(bus, routinesRepo);
    routineEngine.registerProvider("event-bus", provider);

    let routineId = "";
    await runDefer(
      {
        name: "CI on #12",
        event: { eventName: "github.check_suite", filter: [{ field: "pr", equals: "12" }] },
      },
      {
        context: { agentName: "main", sessionId, channelContext },
        createRoutine: async (args) => {
          routineId = await routinesRepo.create(
            args as {
              name: string;
              trigger: Trigger;
              actionName: string;
              args: Record<string, unknown>;
            },
          );
          const row = await routinesRepo.findById(routineId);
          if (!row) throw new Error("routine not stored");
          await routineEngine.activate(toRoutine(row));
          return { routineId };
        },
        now: Date.now(),
      },
    );

    const turnsBefore = testRome.model.prompts().length;
    // A non-matching event leaves the wait armed.
    bus.publish({
      name: "github.check_suite",
      source: "connector",
      payload: { pr: "13" },
      emittedAt: new Date().toISOString(),
    });
    bus.publish({
      name: "github.check_suite",
      source: "connector",
      payload: { pr: "12", conclusion: "success", log: "x".repeat(1_000) },
      emittedAt: new Date().toISOString(),
    });
    // A second match must not wake the session again.
    bus.publish({
      name: "github.check_suite",
      source: "connector",
      payload: { pr: "12", conclusion: "failure" },
      emittedAt: new Date().toISOString(),
    });

    const deadline = Date.now() + 10_000;
    while (testRome.model.prompts().length === turnsBefore && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Give a wrongly-duplicated wakeup the chance to show up.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const wakeups = testRome.model.prompts().slice(turnsBefore);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toContain("📨 Event arrived: CI on #12");
    expect(wakeups[0]).toContain('"conclusion": "success"');
    expect(wakeups[0]).toContain("[1000 chars omitted]");
    expect(testRome.model.sessions.at(-1)?.sessionId).toBe(sessionId);
    expect((await routinesRepo.findById(routineId))?.enabled).toBe(false);
    expect(provider.isActive(routineId)).toBe(false);
    provider.stop();
  });
});
