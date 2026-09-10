import { describe, expect, it } from "@rstest/core";
import { AgentConfigSchema } from "./artifact-config.js";

const base = {
  name: "pinned_agent",
  description: "An agent with explicit model requirements",
  systemPromptPrefix: "Complete the requested task.",
  tools: [],
  permissionMode: "default",
};

function issuePaths(input: Record<string, unknown>): string[] {
  const result = AgentConfigSchema.safeParse({ ...base, ...input });
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("agent exact model configuration", () => {
  it.each([
    ["openai", "gpt-5.3-codex-spark"],
    ["anthropic", "claude-opus-4-6[1m]"],
    ["openai", "future-model-not-in-the-webchat-catalog"],
  ])("preserves %s model ID %s without inventing a tier", (provider, modelId) => {
    const config = AgentConfigSchema.parse({ ...base, provider, modelId });
    expect(config).toMatchObject({ providerId: provider, modelId, reasoningEffort: "high" });
    expect(config).not.toHaveProperty("tier");
    expect(config).not.toHaveProperty("provider");
    expect(config).not.toHaveProperty("model");
  });

  it("requires an explicit provider instead of guessing from the ID", () => {
    expect(issuePaths({ modelId: "gpt-5.3-codex-spark" })).toContain("provider");
  });

  it.each(["", " ", " model", "model ", "two models", "model\n", "model\tid", null, 42])(
    "rejects invalid model ID %j",
    (modelId) => {
      expect(issuePaths({ provider: "openai", modelId })).toContain("modelId");
    },
  );

  it.each(["mock", "unknown", "", null])("rejects invalid provider %j", (provider) => {
    expect(issuePaths({ provider, modelId: "exact-model" })).toContain("provider");
  });

  it.each(["large", "medium", "small"])("rejects modelId combined with tier %s", (tier) => {
    expect(issuePaths({ provider: "openai", modelId: "exact-model", tier })).toContain("modelId");
  });

  it.each(["opus", "sonnet", "haiku"])("rejects modelId combined with legacy model %s", (model) => {
    expect(issuePaths({ provider: "anthropic", modelId: "exact-model", model })).toContain("modelId");
  });

  it("rejects a meaningless pin on a code-backed agent", () => {
    expect(
      issuePaths({ provider: "openai", modelId: "exact-model", codeBacked: true }),
    ).toContain("modelId");
  });

  it("requires a selection rather than silently defaulting", () => {
    expect(issuePaths({})).toContain("tier");
    expect(issuePaths({ provider: "openai" })).toContain("tier");
  });

  it("preserves strict unknown-field validation", () => {
    const result = AgentConfigSchema.safeParse({
      ...base,
      provider: "openai",
      modelId: "exact-model",
      modelID: "misspelled-field",
    });
    expect(result.success).toBe(false);
  });

  it.each(["large", "medium", "small"])("preserves portable tier %s", (tier) => {
    const config = AgentConfigSchema.parse({ ...base, tier });
    expect(config.tier).toBe(tier);
    expect(config).not.toHaveProperty("modelId");
    expect(config).not.toHaveProperty("providerId");
  });

  it.each([
    ["opus", "large"],
    ["sonnet", "medium"],
    ["haiku", "small"],
  ])("preserves legacy model %s as tier %s", (model, tier) => {
    const config = AgentConfigSchema.parse({ ...base, model });
    expect(config.tier).toBe(tier);
    expect(config).not.toHaveProperty("model");
    expect(config).not.toHaveProperty("modelId");
  });

  it("preserves provider-pinned tiers and existing tier-over-legacy precedence", () => {
    const config = AgentConfigSchema.parse({
      ...base,
      provider: "openai",
      tier: "small",
      model: "opus",
    });
    expect(config).toMatchObject({ providerId: "openai", tier: "small" });
  });

  it("preserves reasoning effort and structured-output validation with an exact pin", () => {
    const outputSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const config = AgentConfigSchema.parse({
      ...base,
      provider: "openai",
      modelId: "exact-model",
      reasoningEffort: "low",
      outputSchema,
    });
    expect(config.reasoningEffort).toBe("low");
    expect(config.outputSchema).toEqual(outputSchema);
    expect(
      issuePaths({
        provider: "openai",
        modelId: "exact-model",
        outputSchema: { type: "object", properties: { answer: { type: "not-a-type" } } },
      }),
    ).toContain("outputSchema");
  });
});
