import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig, BackendTurnRunner } from "@rome-os/app-runtime";
import { createResumeSessionAction } from "../../../../rome_apps/system/src/actions/resume-session/index.js";
import { createCreateRoutineAction } from "../../../../rome_apps/system/src/actions/create-routine/index.js";
import { ComputerConsentWatcher } from "../events/computer-consent.js";
import { routineCreationService } from "../routines/create.js";
import { runDefer, type DeferContext } from "../routines/defer.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import { EventBus } from "../events/event-bus.js";
import { systemClock } from "../lib/clock.js";
import { EventBusTriggerProvider } from "../routines/event-bus-trigger-provider.js";
import { RoutineEngine } from "../routines/engine.js";
import type { Trigger } from "../routines/types.js";
import { buildAction, createTestRome, type TestRome } from "../test/kit/index.js";
import { createBackendTurnRunner } from "./backend-turn.js";

const resumeSessionConfig = {
  name: "system:resume_session",
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
      scheduledAt: new Date("2026-11-09T12:00:00Z"),
      channelContext,
    } satisfies DeferContext;
    await runDefer(
      {
        kind: "time",
        name: "deferred follow-up",
        note: "Check the run and tell the guardian.",
        fireAtMs: Date.parse("2026-07-15T12:00:00.000Z") + 60_000,
      },
      {
        context: deferContext,
        createRoutine: async (args) => {
          routineArgs = args;
          return { routineId: "defer-follow-up" };
        },
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

    const deferredSession = await rome.repos.sessions.current(webchatKey, "core:main");

    // Regression assertion: the continuation keeps the original runtime ID and
    // its session key instead of opening a second AgentSession.
    expect({
      sessionId: deferredSession?.id,
      channelThreadKey: deferredSession?.continuityKey,
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
        kind: "event",
        waitingFor: "the event",
        deadlineMs: Date.UTC(2030, 0, 1),
        name: "CI on #12",
        note: "Check the run and tell the guardian.",
        event: { eventName: "github.check_suite", filter: [{ field: "pr", equals: "12" }] },
      },
      {
        context: {
          agentName: "main",
          sessionId,
          channelContext,
          scheduledAt: new Date("2026-11-09T12:00:00Z"),
        },
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
    // The wakeup continued the deferring session: the chat still has it as its current one.
    expect((await testRome.repos.sessions.current("webchat:event-chat", "core:main"))?.id).toBe(
      sessionId,
    );
    expect((await routinesRepo.findById(routineId))?.enabled).toBe(false);
    expect(provider.isActive(routineId)).toBe(false);
    provider.stop();
  });

  it.each([
    "before defer",
    "during polling",
  ])("resumes the same chat on consent %s and watches the next revision across a restart", async (consentAt) => {
    rome = await createTestRome({ keepAliveAcrossTurns: true });
    const runtime = rome;
    const routines = new RoutinesRepository(runtime.db);
    const runs = new RoutineRunsRepository(runtime.db);
    const requestId = "request-1";
    const deviceId = "studio-mac";
    const expiresInMs = 60_000;
    const permissions = {
      status: "needs_system_permission",
      revision: 2,
      missing: ["screen_recording"],
      guideOpened: true,
    };
    const grant = { status: "authorized", revision: 3 };
    let status: Record<string, unknown> =
      consentAt === "before defer" ? permissions : { status: "pending_consent", revision: 1 };
    const devices = {
      runAction: rs.fn(async () => ({
        ok: true as const,
        result: { requestId, expiresInMs, ...status },
      })),
    };
    function startEngine() {
      const engine = new RoutineEngine(routines, runs, runtime.actionEngine, 0, systemClock);
      const bus = new EventBus();
      engine.registerProvider(
        "event-bus",
        new EventBusTriggerProvider(bus, routines, new ComputerConsentWatcher(devices, bus)),
      );
      return engine;
    }
    let engine = startEngine();
    runtime.actionRegistry.register(
      createCreateRoutineAction(buildAction("system:create_routine").config, {
        routineCreation: routineCreationService({
          routinesRepo: routines,
          routineEngine: engine,
          actionRegistry: runtime.actionRegistry,
          resolveOneOffDate: async (trigger) => trigger,
        }),
      }),
    );
    runtime.actionRegistry.register(
      createResumeSessionAction(resumeSessionConfig, {
        backendTurnRunner: createBackendTurnRunner({
          agentRunner: runtime.agentRunner,
          channel: (name) => runtime.channels.find((channel) => channel.name === name) ?? null,
        }),
      } as never),
    );

    const initialPrompt = "Find the Notes window on my Mac.";
    const note = "Run computer.windows with application Notes on studio-mac.";
    const waitIds: string[] = [];
    const modelRun = runtime.model.run.bind(runtime.model);
    rs.spyOn(runtime.model, "run").mockImplementation(async function* (params) {
      const first = params.prompt.includes(initialPrompt);
      if (first || params.prompt.includes('"status": "needs_system_permission"')) {
        const reply = await params.tools.callTool("ask_user", "defer", {
          name: "Notes window access",
          note,
          event: {
            eventName: "computer.consent.changed",
            sourcePattern: "rome-node",
            filter: [
              { field: "deviceId", equals: deviceId },
              { field: "requestId", equals: requestId },
            ],
            afterRevision: first ? 1 : 2,
            expiresInMs,
          },
        });
        if (reply.isError) throw new Error(reply.content[0].text);
        waitIds.push(JSON.parse(reply.content[0].text).routineId);
      }
      yield* modelRun(params);
    });

    try {
      const initial = await runtime.runAgent({
        prompt: initialPrompt,
        channelThreadKey: "webchat:mac-access",
        threadContext: { channel: "webchat", threadId: "mac-access", channelUserId: "guardian" },
      });
      const sessionId = initial.find((message) => message.type === "session_init")?.sessionId;
      expect(sessionId).toBeDefined();
      expect(initial.filter((message) => message.type === "error")).toEqual([]);
      status = permissions;
      await rs.waitFor(() => expect(waitIds).toHaveLength(2), { timeout: 5_000 });
      await rs.waitFor(async () =>
        expect((await runs.findByRoutineId(waitIds[0]))[0]?.status).toBe("success"),
      );
      expect(runtime.model.lastPrompt()).toContain('"guideOpened": true');
      expect(runtime.model.lastPrompt()).toContain("screen_recording");
      expect((await routines.findEnabled()).map((row) => row.id)).toEqual([waitIds[1]]);

      engine.stop();
      if (consentAt === "during polling") status = grant;
      engine = startEngine();
      await engine.start();
      if (consentAt === "before defer") {
        expect((await routines.findEnabled()).map((row) => row.id)).toEqual([waitIds[1]]);
        status = grant;
      }
      await rs.waitFor(
        async () => expect((await runs.findByRoutineId(waitIds[1]))[0]?.status).toBe("success"),
        { timeout: 5_000 },
      );
      expect(runtime.model.prompts()).toHaveLength(3);
      expect(runtime.model.lastPrompt()).toContain(note);
      expect(runtime.model.lastPrompt()).toContain('"status": "authorized"');
      expect((await runtime.repos.sessions.current("webchat:mac-access", "core:main"))?.id).toBe(
        sessionId,
      );
      expect(await routines.findEnabled()).toEqual([]);
    } finally {
      engine.stop();
    }
  });
});
