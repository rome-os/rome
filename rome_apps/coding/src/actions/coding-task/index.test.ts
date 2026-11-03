import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { RomeAppContext } from "@rome-os/app-runtime";

import { validateActionArgs } from "../../../../../packages/core/src/actions/validate-action-args.js";
import { createCodingTaskAction } from "./index.js";

describe("coding_task", () => {
  beforeEach(() => {
    rs.clearAllMocks();
  });

  it("delegates to summon with the coding agent", async () => {
    const runAction = rs.fn().mockResolvedValue({
      status: "ok",
      data: { result: "done", sessionId: "s1" },
    });

    const action = createCodingTaskAction(
      {
        name: "coding_task",
        type: "custom",
        description: "Run coding work",
        complexity: "complex",
        speed: "slow",
        reliability: "high",
        sideEffects: "write",
      },
      {
        appContext: {
          runAction,
        } as unknown as RomeAppContext,
      },
    );

    const result = await action.execute({
      prompt: "fix the failing test",
      sessionId: "resume-me",
    });

    expect(runAction).toHaveBeenCalledWith("summon", {
      agentName: "coding",
      prompt: "fix the failing test",
      sessionId: "resume-me",
    });
    expect(result).toEqual({
      status: "ok",
      data: { result: "done", sessionId: "s1" },
    });
  });

  it("declares a schema that rejects every prompt execute rejects", async () => {
    const action = createCodingTaskAction(
      {
        name: "coding_task",
        type: "custom",
        description: "Run coding work",
        complexity: "complex",
        speed: "slow",
        reliability: "high",
        sideEffects: "write",
      },
      { appContext: { runAction: rs.fn() } as unknown as RomeAppContext },
    );

    for (const args of [{}, { prompt: "" }, { prompt: " \n\t" }, { prompt: 42 }]) {
      expect(await action.execute(args)).toEqual({ status: "error", error: "prompt is required" });
      expect(validateActionArgs("coding_task", args, action.inputSchema)).not.toBeNull();
    }
    expect(validateActionArgs("coding_task", { prompt: "fix it" }, action.inputSchema)).toBeNull();
  });
});
