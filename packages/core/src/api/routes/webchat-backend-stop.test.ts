import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createWebchatRuntime } from "./webchat.js";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../../test/helpers.js";
import type { AgentSession } from "../../core/agent-session.js";

// Stop on a backend turn (a task-event or defer turn the runtime streams under
// a synthetic `backend:` id).
describe("Stop on a backend turn", () => {
  const originalProjectsRoot = process.env.ROME_PROJECTS_ROOT;
  const sessionId = "sess-backend-stop";
  let testDb: TestDb;
  let deps: TestDeps;
  let projectsRoot: string;

  beforeEach(async () => {
    projectsRoot = mkdtempSync(join(tmpdir(), "rome-backend-stop-"));
    process.env.ROME_PROJECTS_ROOT = projectsRoot;
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    await deps.webchatRepo.createSession(sessionId, "Backend stop");
  });

  afterEach(() => {
    rs.useRealTimers();
    rs.restoreAllMocks();
    testDb.close();
    rmSync(projectsRoot, { recursive: true, force: true });
    if (originalProjectsRoot === undefined) delete process.env.ROME_PROJECTS_ROOT;
    else process.env.ROME_PROJECTS_ROOT = originalProjectsRoot;
  });

  function setup() {
    const owner = { currentTurnId: "provider-turn", interrupt: rs.fn(async () => {}) };
    rs.spyOn(deps.agentSessionManager, "peek").mockReturnValue(owner as unknown as AgentSession);
    const { routes, runtime } = createWebchatRuntime(deps);
    const backendTurnId = async () => {
      let turnId = "";
      await rs.waitFor(async () => {
        const turns = await (await routes.request(`/chat/sessions/${sessionId}/turns`)).json();
        turnId = turns[0]?.turnId;
        expect(turnId).toMatch(/^backend:/);
      });
      return turnId;
    };
    const stop = (turnId: string) =>
      routes.request(`/chat/turns/${turnId}/interrupt`, { method: "POST" });
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };
    const turnStart = {
      type: "turn_start",
      turnId: "provider-turn",
      sessionId: "provider-session",
      userPrompt: "Continue",
    } as const;
    return { owner, runtime, backendTurnId, stop, gate, turnStart };
  }

  it("answers 202 before the provider turn starts, then interrupts it as it starts", async () => {
    const { owner, runtime, backendTurnId, stop, gate, turnStart } = setup();
    const startAfter = gate();
    const onStopped = rs.fn();
    const task = runtime.enqueueSessionTask(
      sessionId,
      async ({ emit }) => {
        await startAfter.opened;
        await emit(turnStart);
        await emit({
          type: "turn_end",
          turnId: "provider-turn",
          status: "interrupted",
          durationMs: 1,
        });
      },
      { onStopped },
    );
    const turnId = await backendTurnId();

    const res = await stop(turnId);

    expect(res.status).toBe(202);
    expect(owner.interrupt).not.toHaveBeenCalled();
    startAfter.open();
    await task;
    expect(owner.interrupt).toHaveBeenCalledTimes(1);
    expect(owner.interrupt).toHaveBeenCalledWith("user-stop");
    expect(onStopped).toHaveBeenCalledTimes(1);
    await runtime.flushAll();
  });

  it("does not interrupt a provider turn other than the one the task started", async () => {
    const { owner, runtime, backendTurnId, stop, gate, turnStart } = setup();
    owner.currentTurnId = "someone-elses-turn";
    const startAfter = gate();
    const task = runtime.enqueueSessionTask(sessionId, async ({ emit }) => {
      await startAfter.opened;
      await emit(turnStart);
    });
    expect((await stop(await backendTurnId())).status).toBe(202);

    startAfter.open();
    await task;

    expect(owner.interrupt).not.toHaveBeenCalled();
    await runtime.flushAll();
  });

  it("reports a Stop that landed on a started turn, and nothing for a turn that ended on its own", async () => {
    const { owner, runtime, backendTurnId, stop, gate, turnStart } = setup();
    const onStopped = rs.fn();
    const end = gate();
    const stopped = runtime.enqueueSessionTask(
      sessionId,
      async ({ emit }) => {
        await emit(turnStart);
        await end.opened;
      },
      { onStopped },
    );
    expect((await stop(await backendTurnId())).status).toBe(202);
    expect(owner.interrupt).toHaveBeenCalledTimes(1);
    end.open();
    await stopped;
    expect(onStopped).toHaveBeenCalledTimes(1);

    const untouched = rs.fn();
    await runtime.enqueueSessionTask(
      sessionId,
      async ({ emit }) => {
        await emit(turnStart);
      },
      { onStopped: untouched },
    );
    expect(untouched).not.toHaveBeenCalled();
    await runtime.flushAll();
  });
});
