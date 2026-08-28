import { afterEach, describe, expect, it } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createResumeSessionAction } from "../../../../rome_apps/system/src/actions/resume-session/index.js";
import { runDefer, type DeferContext } from "../core/defer.js";
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

  it("resumes the AgentSession that scheduled defer when webchat uses a selected-model key", async () => {
    rome = await createTestRome({ keepAliveAcrossTurns: true });

    const webchatSessionId = "selected-model-chat";
    const selectedModelKey = `webchat:${webchatSessionId}:large-model:gpt-5-6-sol`;
    const channelContext = {
      channel: "webchat",
      threadId: webchatSessionId,
      channelUserId: "guardian",
    };

    // This is the key shape used by the normal WebChat turn path when the chat
    // has a persisted large-model selection.
    const initialMessages = await rome.runAgent({
      prompt: "Start work and check again later",
      channelThreadKey: selectedModelKey,
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
      { name: "selected-model follow-up", afterMinutes: 1 },
      {
        context: deferContext,
        createRoutine: async (args) => {
          routineArgs = args;
          return { routineId: "defer-selected-model" };
        },
        now: Date.parse("2026-07-15T12:00:00.000Z"),
      },
    );

    const backendTurnRunner = createBackendTurnRunner({
      agentRunner: rome.agentRunner,
      talkRouter: rome.talkRouter,
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

    // Regression assertion: the old path created a second AgentSession whose
    // key was only `webchat:selected-model-chat`. The continuation must instead
    // keep both the original runtime ID and its selected-model session key.
    expect({
      sessionId: deferredSessionId,
      channelThreadKey: deferredSession?.channelThreadKey,
    }).toEqual({
      sessionId: initialSessionId,
      channelThreadKey: selectedModelKey,
    });
  });
});
