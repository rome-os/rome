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
  it("reads runsOwnTurns as deprecatedRunsOwnTurns", () => {
    const config = AgentConfigSchema.parse({ ...base, runsOwnTurns: true });
    expect(config.deprecatedRunsOwnTurns).toBe(true);
    expect(config).not.toHaveProperty("runsOwnTurns");
  });

  it("reads the key's earlier name too, for apps built before it", () => {
    const config = AgentConfigSchema.parse({ ...base, unsafeTestOnlyBypassInbox: true });
    expect(config.deprecatedRunsOwnTurns).toBe(true);
    expect(config).not.toHaveProperty("unsafeTestOnlyBypassInbox");
  });

  it("lets runsOwnTurns win when an app sends both", () => {
    const config = AgentConfigSchema.parse({
      ...base,
      runsOwnTurns: false,
      unsafeTestOnlyBypassInbox: true,
    });
    expect(config.deprecatedRunsOwnTurns).toBe(false);
  });

  it("refuses the internal name as a key, so no app depends on it", () => {
    expect(() => AgentConfigSchema.parse({ ...base, deprecatedRunsOwnTurns: true })).toThrow();
  });

  it("leaves it out when the app sets neither", () => {
    expect(AgentConfigSchema.parse(base)).not.toHaveProperty("deprecatedRunsOwnTurns");
  });
});
