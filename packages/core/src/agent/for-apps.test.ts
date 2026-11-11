import { describe, it, expect, rs } from "@rstest/core";
import { agentWorkerCalls } from "./for-apps.js";

describe("agent.hasAgent", () => {
  it("answers from the catalog", async () => {
    const hasAgent = rs.fn((name: string) => name === "main");
    const calls = agentWorkerCalls({ hasAgent, hasAction: () => false });

    expect(await calls["agent.hasAgent"]({ name: "main" })).toEqual({ hasAgent: true });
    expect(await calls["agent.hasAgent"]({ name: "gone" })).toEqual({ hasAgent: false });
  });

  it("rejects an empty name without asking the catalog", async () => {
    const hasAgent = rs.fn(() => true);
    const calls = agentWorkerCalls({ hasAgent, hasAction: () => false });

    await expect(calls["agent.hasAgent"]({ name: "" })).rejects.toThrow(
      "agent.hasAgent: invalid params",
    );
    expect(hasAgent).not.toHaveBeenCalled();
  });
});

describe("agent.hasAction", () => {
  it("answers whether the agent may call the action", async () => {
    const hasAction = rs.fn(() => true);
    const calls = agentWorkerCalls({ hasAgent: () => true, hasAction });

    expect(await calls["agent.hasAction"]({ agentName: "main", actionName: "x:y" })).toEqual({
      hasAction: true,
    });
    expect(hasAction).toHaveBeenCalledWith("main", "x:y");
  });

  it("rejects a missing action name", async () => {
    const calls = agentWorkerCalls({ hasAgent: () => true, hasAction: () => true });

    await expect(calls["agent.hasAction"]({ agentName: "main" })).rejects.toThrow(
      "agent.hasAction: invalid params",
    );
  });
});
