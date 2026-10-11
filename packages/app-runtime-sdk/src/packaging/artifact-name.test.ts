import { describe, expect, it } from "@rstest/core";
import { ActionConfigSchema, AgentConfigSchema } from "./artifact-config.js";
import { parseAppManifest } from "./manifest.js";

const action = {
  name: "review",
  type: "custom",
  description: "Review code",
  complexity: "moderate",
  speed: "moderate",
  reliability: "high",
  sideEffects: "read-only",
};

const agent = {
  name: "reviewer",
  description: "Reviews code",
  tier: "medium",
  systemPromptPrefix: "Review carefully.",
  tools: [],
  permissionMode: "default",
};

describe("artifact local names", () => {
  it("rejects colon in action and agent config names", () => {
    expect(ActionConfigSchema.safeParse({ ...action, name: "app:review" }).success).toBe(false);
    expect(AgentConfigSchema.safeParse({ ...agent, name: "app:reviewer" }).success).toBe(false);
  });

  it("rejects colon in manifest public names and aliases", () => {
    expect(() =>
      parseAppManifest(
        {
          formatVersion: 1,
          id: "review-app",
          version: "1.0.0",
          description: "Review",
          actions: [{ path: "actions/review", publicName: "app:review" }],
        },
        "app.yaml",
      ),
    ).toThrow(/must not contain ":"/);
  });

  it("accepts qualified v2 references and rejects self and bare references", () => {
    expect(() =>
      parseAppManifest(
        {
          formatVersion: 2,
          id: "review-app",
          version: "1.0.0",
          description: "Review",
          suggestedChannelBindings: [{ channel: "webchat", agent: "review-app:reviewer" }],
        },
        "app.yaml",
      ),
    ).not.toThrow();
    expect(() =>
      parseAppManifest(
        {
          formatVersion: 2,
          id: "review-app",
          version: "1.0.0",
          description: "Review",
          suggestedChannelBindings: [{ channel: "webchat", agent: "self:reviewer" }],
        },
        "app.yaml",
      ),
    ).toThrow(/qualified artifact ID/);
    expect(() =>
      parseAppManifest(
        {
          formatVersion: 2,
          id: "review-app",
          version: "1.0.0",
          description: "Review",
          suggestedChannelBindings: [{ channel: "webchat", agent: "reviewer" }],
        },
        "app.yaml",
      ),
    ).toThrow(/qualified artifact ID/);
  });
});
