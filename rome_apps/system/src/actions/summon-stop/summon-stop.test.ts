import { describe, it, expect, rs } from "@rstest/core";
import type { ActionResult } from "@rome-os/app-runtime";
import { createSummonStopAction } from "./index.js";

const actionConfig = {
  name: "summon_stop",
  type: "system",
  description: "Stop a detached summon's child session",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "write",
} as const;

function makeTool(stop: ReturnType<typeof rs.fn>) {
  return createSummonStopAction(actionConfig, {
    childSessions: { startDetached: rs.fn(), getStatus: rs.fn(), stop },
  });
}

describe("summon_stop", () => {
  it("reports the stop it asked for", async () => {
    const stop = rs.fn(async () => ({ stopped: true, status: "running" as const }));

    const result = await makeTool(stop).execute({ sessionId: "child-1" });

    expect(result).toEqual({
      status: "ok",
      data: { sessionId: "child-1", stopped: true, status: "running" },
    });
    expect(stop).toHaveBeenCalledWith({ sessionId: "child-1" });
  });

  it("reports the status when there was nothing to stop", async () => {
    // Idempotent by design: a manager polling on a schedule can call this
    // without first proving the child is alive.
    const stop = rs.fn(async () => ({ stopped: false, status: "completed" as const }));

    const result = await makeTool(stop).execute({ sessionId: "child-1" });

    expect(result).toEqual({
      status: "ok",
      data: { sessionId: "child-1", stopped: false, status: "completed" },
    });
  });

  it("reports not_found for a child the calling agent does not own", async () => {
    const stop = rs.fn(async () => null);

    const result = await makeTool(stop).execute({ sessionId: "nope" });

    expect(result).toEqual({ status: "ok", data: { status: "not_found", sessionId: "nope" } });
  });

  it("rejects input with no session id without asking the host", async () => {
    const stop = rs.fn();

    const result = (await makeTool(stop).execute({})) as ActionResult;

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Invalid input/);
    expect(stop).not.toHaveBeenCalled();
  });

  it("previews the session it will stop", () => {
    const payload = makeTool(rs.fn()).preview!({ sessionId: "child-1" });

    expect(payload).toEqual({
      kind: "generic",
      title: "Stop a summoned agent",
      summary: "child-1",
    });
  });
});
