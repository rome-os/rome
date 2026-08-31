import { describe, expect, it } from "@rstest/core";
import { prettyAgentName } from "./agent-name";

describe("prettyAgentName", () => {
  it("humanizes legacy bare names", () => {
    expect(prettyAgentName("workflow-planner")).toBe("Workflow Planner");
  });

  it("does not expose the canonical app namespace", () => {
    expect(prettyAgentName("dream:skill-review")).toBe("Skill Review");
  });
});
