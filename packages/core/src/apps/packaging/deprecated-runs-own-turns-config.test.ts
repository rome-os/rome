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

describe("deprecatedRunsOwnTurns in an agent's config", () => {
  it("keeps deprecatedRunsOwnTurns", () => {
    expect(
      AgentConfigSchema.parse({ ...base, deprecatedRunsOwnTurns: true }).deprecatedRunsOwnTurns,
    ).toBe(true);
  });

  it("reads its earlier names as deprecatedRunsOwnTurns, for apps built before the rename", () => {
    for (const earlier of ["runsOwnTurns", "unsafeTestOnlyBypassInbox"]) {
      const config = AgentConfigSchema.parse({ ...base, [earlier]: true });
      expect(config.deprecatedRunsOwnTurns).toBe(true);
      expect(config).not.toHaveProperty(earlier);
    }
  });

  it("lets the newest name win when an app sends several", () => {
    const config = AgentConfigSchema.parse({
      ...base,
      deprecatedRunsOwnTurns: false,
      runsOwnTurns: true,
      unsafeTestOnlyBypassInbox: true,
    });
    expect(config.deprecatedRunsOwnTurns).toBe(false);
  });

  it("leaves it out when the app sets none", () => {
    expect(AgentConfigSchema.parse(base)).not.toHaveProperty("deprecatedRunsOwnTurns");
  });
});
