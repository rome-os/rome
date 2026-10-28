import type { ActionConfig, ActionResult, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";

const mocks = rs.hoisted(() => ({
  finish: rs.fn(),
}));

rs.mock("../../db/repositories/scouts.js", () => ({
  createScoutsRepository: () => ({
    byId: async (id: string) => ({ id, title: "Competitors", prompt: "Check competitors" }),
    markRun: async () => {},
  }),
}));

rs.mock("../../db/repositories/scout-results.js", () => ({
  createScoutResultsRepository: () => ({
    start: async () => "result-1",
    finish: mocks.finish,
  }),
}));

import { createAction } from "./index.js";

const config: ActionConfig = {
  name: "briefing_run_scout",
  type: "custom",
  description: "Run a scouting task",
  complexity: "moderate",
  speed: "slow",
  reliability: "medium",
  sideEffects: "write",
};

function run(summon: () => Promise<ActionResult>) {
  const deps = {
    appContext: { db: {}, runAction: summon },
  } as unknown as AppActionRuntimeDeps;
  return createAction(config, deps).execute({ scoutId: "scout-1" });
}

describe("briefing_run_scout", () => {
  beforeEach(() => {
    mocks.finish.mockReset();
  });

  it("reports a failed summon as an error after storing the failed run", async () => {
    const result = await run(async () => ({
      status: "error",
      error: "No model provider is available",
    }));

    expect(result).toEqual({ status: "error", error: "No model provider is available" });
    expect(mocks.finish).toHaveBeenCalledWith("result-1", {
      status: "failed",
      error: "No model provider is available",
    });
  });

  it("reports a thrown summon as an error", async () => {
    const result = await run(async () => {
      throw new Error("rate limit exceeded");
    });

    expect(result).toEqual({ status: "error", error: "rate limit exceeded" });
    expect(mocks.finish).toHaveBeenCalledWith("result-1", {
      status: "failed",
      error: "rate limit exceeded",
    });
  });

  it("reports an empty reply as an error", async () => {
    const result = await run(async () => ({ status: "ok", data: { result: "" } }));

    expect(result).toEqual({ status: "error", error: "The assistant returned no findings." });
    expect(mocks.finish).toHaveBeenCalledWith("result-1", {
      status: "failed",
      error: "The assistant returned no findings.",
    });
  });

  it("keeps a run with no findings ok", async () => {
    const result = await run(async () => ({ status: "ok", data: { result: "NO_FINDINGS" } }));

    expect(result).toEqual({ status: "ok", data: { resultId: "result-1", status: "skipped" } });
  });

  it("keeps a run with findings ok", async () => {
    const result = await run(async () => ({
      status: "ok",
      data: { result: "- A rival launched" },
    }));

    expect(result.status).toBe("ok");
    expect(mocks.finish).toHaveBeenCalledWith("result-1", {
      status: "completed",
      content: "- A rival launched",
    });
  });
});
