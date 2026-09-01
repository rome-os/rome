import { z } from "zod";
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORT_VALUES } from "@rome-os/app-runtime";
import { ArtifactLocalNameSchema } from "./artifact-name.js";
import { compileOutputSchema, validatePortableOutputSchema } from "./output-schema-validator.js";

const FavorRequirementSchema = z
  .object({
    amount: z.number().int().positive(),
    title: z.string().min(1),
    summary: z.string().min(1).optional(),
    displayFields: z
      .array(
        z
          .object({
            label: z.string().min(1),
            from: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

/**
 * Strict schemas for the per-artifact YAML configs a packed bundle ships
 * (`action.yaml`, agent yamls). Unknown fields are rejected, not stripped:
 * packed bundles are immutable once published, so a field tolerated here
 * would have to be tolerated forever. One schema serves both gates — the
 * runtime loaders (`actions/loader.ts`, `core/agent-loader.ts`) and
 * pack/install validation (`validate.ts`) — and the bundle's
 * `formatVersion` (in app.yaml) governs it.
 */
export const ActionConfigSchema = z
  .object({
    name: ArtifactLocalNameSchema,
    type: z.enum(["system", "custom"]),
    description: z.string().min(1),
    entry: z.string().min(1).optional(),
    complexity: z.enum(["simple", "moderate", "complex"]),
    speed: z.enum(["fast", "moderate", "slow"]),
    reliability: z.enum(["high", "medium", "low"]),
    sideEffects: z.enum(["read-only", "write"]),
    requiresApproval: z.boolean().optional(),
    cancellable: z.boolean().optional(),
    webhook: z.boolean().optional(),
    favorRequirement: FavorRequirementSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.webhook && config.requiresApproval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["webhook"],
        message: "webhook actions cannot require approval in v1",
      });
    }
    if (config.favorRequirement && config.requiresApproval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["favorRequirement"],
        message: "favor-required actions cannot require approval in v1",
      });
    }
  });

// Provider-agnostic capability tiers. New configs should use `tier:`.
const TIER_VALUES = ["large", "medium", "small"] as const;

// Real model providers an agent may pin itself to. Deliberately excludes
// "mock": pins ship in packed bundles, and a test-only provider must never be
// publishable.
const PROVIDER_VALUES = ["anthropic", "openai"] as const;

// Legacy Anthropic-shaped values still accepted via `model:` for back-compat.
// Mapped silently to the corresponding tier.
const LEGACY_MODEL_TO_TIER: Record<string, (typeof TIER_VALUES)[number]> = {
  opus: "large",
  sonnet: "medium",
  haiku: "small",
};

export const AgentConfigSchema = z
  .object({
    name: ArtifactLocalNameSchema,
    description: z.string().min(1),
    tier: z.enum(TIER_VALUES).optional(),
    model: z.enum(["opus", "sonnet", "haiku"]).optional(),
    reasoningEffort: z.enum(REASONING_EFFORT_VALUES).default(DEFAULT_REASONING_EFFORT),
    provider: z.enum(PROVIDER_VALUES).optional(),
    systemPromptPrefix: z.string().min(1),
    tools: z.array(z.string().min(1)),
    actions: z.array(z.string().min(1)).optional(),
    permissionMode: z.enum(["acceptEdits", "bypassPermissions", "default"]),
    maxTurns: z.number().int().positive().optional(),
    allowedSubagents: z.array(z.string().min(1)).optional(),
    mcpServers: z
      .record(
        z.string(),
        z
          .object({
            command: z.string().min(1),
            args: z.array(z.string()),
          })
          .strict(),
      )
      .optional(),
    networkDiscovery: z.boolean().optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    // A code-backed agent. Its turns are always produced by a
    // turn-middleware, never a model, so the session opens no provider query.
    codeBacked: z.boolean().optional(),
  })
  .strict()
  .superRefine((raw, ctx) => {
    if (!raw.outputSchema) return;
    const portabilityIssues = validatePortableOutputSchema(raw.outputSchema);
    for (const issue of portabilityIssues) {
      ctx.addIssue({ code: "custom", path: ["outputSchema"], message: issue });
    }
    if (portabilityIssues.length > 0) return;
    try {
      compileOutputSchema(raw.outputSchema);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        path: ["outputSchema"],
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })
  .transform((raw, ctx) => {
    const tier = raw.tier ?? (raw.model ? LEGACY_MODEL_TO_TIER[raw.model] : undefined);
    if (!tier) {
      ctx.addIssue({
        code: "custom",
        path: ["tier"],
        message:
          "Required (either `tier: large|medium|small` or legacy `model: opus|sonnet|haiku`)",
      });
      return z.NEVER;
    }
    const { model: _legacy, tier: _tier, provider, ...rest } = raw;
    return { ...rest, tier, ...(provider ? { providerId: provider } : {}) };
  });
