import { describe, it, expect, rs } from "@rstest/core";
import type { ActionResult, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import type { AgentRunner } from "../../../../../packages/core/src/core/agent-runner.js";
import { createAction, type DreamDeps } from "./index.js";

const actionConfig = {
  name: "dream",
  type: "custom",
  description: "Daily self-review",
  complexity: "moderate",
  speed: "slow",
  reliability: "high",
  sideEffects: "write",
} as const;

function makeDeps(
  agentMessages: Array<{ type: string; content?: string; error?: string }>,
  overrides?: {
    runAction?: (...args: unknown[]) => Promise<ActionResult>;
    listRoutines?: () => Promise<Array<{ actionName: string; name: string }>>;
  },
): AppActionRuntimeDeps<DreamDeps> {
  return {
    agentRunner: {
      async *run() {
        for (const msg of agentMessages) {
          yield msg;
        }
      },
    } as unknown as AgentRunner,
    appContext: {
      runAction: overrides?.runAction ?? rs.fn().mockResolvedValue({ status: "ok" }),
      listRoutines: overrides?.listRoutines ?? rs.fn().mockResolvedValue([]),
    },
  } as unknown as AppActionRuntimeDeps<DreamDeps>;
}

describe("dream", () => {
  it("runs agent and returns summary on success", async () => {
    const deps = makeDeps([
      { type: "text", content: "thinking..." },
      { type: "result", content: "Journal entry written." },
    ]);

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { summary: string; windowHours: number };
    expect(data.summary).toBe("Journal entry written.");
    expect(data.windowHours).toBe(24);
  });

  it("returns failure when agent emits an error", async () => {
    const deps = makeDeps([{ type: "error", error: "Model timeout" }]);

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("Model timeout");
  });

  it("uses custom windowHours", async () => {
    const deps = makeDeps([{ type: "result", content: "done" }]);

    const action = createAction(actionConfig, deps);
    const result = await action.execute({ windowHours: 12 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { windowHours: number };
    expect(data.windowHours).toBe(12);
  });

  it("registers daily schedule when none exists", async () => {
    const runAction = rs.fn().mockResolvedValue({ status: "ok" });
    const listRoutines = rs.fn().mockResolvedValue([]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    await action.execute({});

    expect(listRoutines).toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledWith(
      "create_routine",
      expect.objectContaining({
        actionName: "dream",
        trigger: expect.objectContaining({ type: "schedule", rrule: "FREQ=DAILY" }),
      }),
    );
  });

  it("still registers the daily routine when an unrelated dream routine exists", async () => {
    const runAction = rs.fn().mockResolvedValue({ status: "ok" });
    // A different routine that happens to run the `dream` action must not
    // suppress the required daily self-register (dedup is on name, not action).
    const listRoutines = rs.fn().mockResolvedValue([{ actionName: "dream", name: "weekly-dream" }]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    await action.execute({});

    expect(runAction).toHaveBeenCalledWith("create_routine", expect.anything());
  });

  it("skips scheduling when dream event already exists", async () => {
    const runAction = rs.fn().mockResolvedValue({ status: "ok" });
    const listRoutines = rs.fn().mockResolvedValue([{ actionName: "dream", name: "daily-dream" }]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    await action.execute({});

    expect(runAction).not.toHaveBeenCalled();
  });

  it("continues even if schedule registration fails", async () => {
    const runAction = rs.fn().mockRejectedValue(new Error("schedule failed"));
    const listRoutines = rs.fn().mockResolvedValue([]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    expect(result.status).toBe("ok");
  });

  it("continues when create_routine reports a soft failure", async () => {
    // create_routine returns { status: "error" } rather than throwing; the dream
    // run must still complete (registration failure is non-fatal) and must not
    // treat the soft failure as a scheduled routine.
    const runAction = rs.fn().mockResolvedValue({ status: "error", error: "bad trigger" });
    const listRoutines = rs.fn().mockResolvedValue([]);
    const deps = makeDeps([{ type: "result", content: "done" }], { runAction, listRoutines });

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    expect(result.status).toBe("ok");
    expect(runAction).toHaveBeenCalledWith("create_routine", expect.anything());
  });
});
