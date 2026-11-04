import { describe, expect, it } from "@rstest/core";
import { prettyAgentName, mainAgentDisplayName } from "./agent-name";

describe("prettyAgentName", () => {
  it("humanizes legacy bare names", () => {
    expect(prettyAgentName("workflow-planner")).toBe("Workflow Planner");
  });

  it("does not expose the canonical app namespace", () => {
    expect(prettyAgentName("dream:skill-review")).toBe("Skill Review");
  });
});

describe("mainAgentDisplayName", () => {
  it("trims the configured name and otherwise uses the dashboard role label", () => {
    expect(mainAgentDisplayName("  Atlas  ")).toBe("Atlas");
    for (const empty of [undefined, null, "", "  ", 42]) {
      expect(mainAgentDisplayName(empty)).toBe("Rome");
      expect(mainAgentDisplayName(empty, "Localized assistant")).toBe("Localized assistant");
    }
  });
});
