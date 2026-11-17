import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as telemetry from "../../telemetry.js" with { rstest: "importActual" };
import { buildTestDeps, type TestDeps } from "../../test/helpers.js";
import { createTestDb } from "../../test/db.js";
import { createWebchatRuntime } from "./webchat.js";

const recorded = rs.hoisted(() => rs.fn());
rs.mock("../../telemetry.js", () => ({ ...telemetry, recordConciergeTurnMetrics: recorded }));

// The main Concierge chat: its id makes it one.
const CHAT = "concierge";

describe("Concierge turn timing", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let deps: TestDeps;

  beforeEach(async () => {
    recorded.mockClear();
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    await deps.webchatRepo.createSession(CHAT, "Concierge");
  });

  afterEach(() => testDb.close());

  it("times a system turn by its own messages, never another turn's", async () => {
    const { runtime } = createWebchatRuntime(deps);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = runtime.enqueueSessionTask(CHAT, async ({ emit }) => {
      emit(
        { type: "turn_start", turnId: "relay", sessionId: "runtime", userPrompt: "relay" },
        { recorded: true },
      );
      await gate;
      emit(
        { type: "turn_end", turnId: "relay", status: "completed", durationMs: 1 },
        { recorded: true },
      );
    });
    await rs.waitFor(() => expect(runtime.isRunning(CHAT)).toBe(true));
    // A message of another turn, such as the owner's next one queued behind
    // this, is not this turn's first say.
    await deps.webchatRepo.addBackendMessage(CHAT, "owner-turn", [
      { type: "text", content: "Not mine." },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await deps.webchatRepo.addBackendMessage(CHAT, "relay", [{ type: "text", content: "Done." }]);
    release();
    await task;
    await runtime.flushAll();
    expect(recorded).toHaveBeenCalledTimes(1);
    const [facts] = recorded.mock.calls[0] as [{ trigger: string; firstSayMs: number | null }];
    expect(facts.trigger).toBe("system");
    expect(facts.firstSayMs).toBeGreaterThanOrEqual(20);
  });

  it("reports a quiet turn once it said something, and a silent one never", async () => {
    const { runtime } = createWebchatRuntime(deps);
    const quiet = (turnId: string, say: boolean) =>
      runtime.enqueueSessionTask(
        CHAT,
        async ({ emit }) => {
          emit(
            { type: "turn_start", turnId, sessionId: "runtime", userPrompt: "digest" },
            { recorded: true },
          );
          if (say)
            await deps.webchatRepo.addBackendMessage(CHAT, turnId, [
              { type: "text", content: "Digest." },
            ]);
          emit(
            { type: "turn_end", turnId, status: "completed", durationMs: 1 },
            { recorded: true },
          );
        },
        { quiet: true },
      );
    await quiet("silent", false);
    await runtime.flushAll();
    expect(recorded).not.toHaveBeenCalled();
    await quiet("speaks", true);
    await runtime.flushAll();
    expect(recorded).toHaveBeenCalledTimes(1);
  });
});
