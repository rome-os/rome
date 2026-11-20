import { describe, expect, it } from "@rstest/core";
import { AgentConfigSchema } from "./artifact-config.js";

const base = {
  name: "chief-of-staff",
  description: "An agent whose app runs its turns",
  systemPromptPrefix: "Complete the requested task.",
  tools: [],
  permissionMode: "default",
  tier: "large",
};

describe("runsOwnTurns in an agent's config", () => {
  it("keeps runsOwnTurns", () => {
    expect(AgentConfigSchema.parse({ ...base, runsOwnTurns: true }).runsOwnTurns).toBe(true);
  });

  it("reads the old name as runsOwnTurns, for apps built before it", () => {
    const config = AgentConfigSchema.parse({ ...base, unsafeTestOnlyBypassInbox: true });
    expect(config.runsOwnTurns).toBe(true);
    expect(config).not.toHaveProperty("unsafeTestOnlyBypassInbox");
  });

  it("lets the new name win when an app sends both", () => {
    const config = AgentConfigSchema.parse({
      ...base,
      runsOwnTurns: false,
      unsafeTestOnlyBypassInbox: true,
    });
    expect(config.runsOwnTurns).toBe(false);
  });

  it("leaves it out when the app sets neither", () => {
    expect(AgentConfigSchema.parse(base)).not.toHaveProperty("runsOwnTurns");
  });
});
