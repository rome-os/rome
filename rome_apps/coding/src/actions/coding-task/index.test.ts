import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { RomeAppContext } from "@rome-os/app-runtime";

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
});
