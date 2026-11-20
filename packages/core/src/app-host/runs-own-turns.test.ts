import { describe, expect, it } from "@rstest/core";
import type { Agent } from "../agent/index.js";
import { runsOwnTurns } from "./runs-own-turns.js";

function agent(
  ownerId: string,
  runs: boolean | undefined,
  ownerType: Agent["ownerType"] = "app",
): Agent {
  return {
    name: `${ownerId}:agent` as Agent["name"],
    localName: "agent",
    ownerType,
    ownerId,
    definition: {
      description: "",
      reasoningEffort: "low",
      systemPromptPrefix: "",
      tools: [],
      permissionMode: "default",
      ...(runs === undefined ? {} : { runsOwnTurns: runs }),
    },
  };
}

describe("runsOwnTurns", () => {
  it("lets the chief of staff's agent run its own turns", () => {
    expect(runsOwnTurns(agent("chief-of-staff", true))).toBe(true);
  });

  it("refuses every other app, core, and an agent that does not ask", () => {
    expect(runsOwnTurns(agent("sales", true))).toBe(false);
    expect(runsOwnTurns(agent("chief-of-staff", true, "core"))).toBe(false);
    expect(runsOwnTurns(agent("chief-of-staff", false))).toBe(false);
    expect(runsOwnTurns(agent("chief-of-staff", undefined))).toBe(false);
    expect(runsOwnTurns(undefined)).toBe(false);
  });
});
