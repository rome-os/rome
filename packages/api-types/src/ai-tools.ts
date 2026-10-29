import { z } from "zod";
import { isAnthropicCompatibleConfigurationId } from "./anthropic-compatible-providers.js";

const anthropicCompatibleCredentialsSummarySchema = z.object({
  provider: z.custom<
    import("./anthropic-compatible-providers.js").AnthropicCompatibleConfigurationId
  >(isAnthropicCompatibleConfigurationId),
  providerName: z.string(),
  hasApiKey: z.boolean(),
  updatedAt: z.string(),
  needsReauth: z.boolean().optional(),
});

/**
 * The Claude and Codex CLIs report an unknown field as null, as in
 * `email: null`, and pass through values Rome does not shape. Such a field
 * reads as absent, so it never fails the whole status every surface reads.
 */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional()).catch(undefined);

export const usageWindowStatusSchema = z.object({
  usedPercent: optional(z.number().finite().min(0).max(100)),
  remainingPercent: optional(z.number().finite().min(0).max(100)),
  resetsAt: optional(z.string()),
});
export const aiToolUsageStatusSchema = z.object({
  checkedAt: z.string(),
  source: z.string(),
  fiveHour: optional(usageWindowStatusSchema),
  sevenDay: optional(usageWindowStatusSchema),
  error: optional(z.string()),
});
export const aiToolStatusSchema = z.object({
  solAccess: optional(z.boolean()),
  lunaAccess: optional(z.boolean()),
  anthropicCompatible: anthropicCompatibleCredentialsSummarySchema
    .nullable()
    .optional()
    .catch(null),
  loggedIn: optional(z.boolean()),
  quotaExhausted: optional(z.boolean()),
  quotaExhaustedUntil: optional(z.string()),
  email: optional(z.string()),
  authMethod: optional(z.string()),
  accountType: optional(z.string()),
  needsReauth: optional(z.boolean()),
  usage: optional(aiToolUsageStatusSchema),
});
export const aiToolsStatusSchema = z.object({
  claude: aiToolStatusSchema.optional(),
  codex: aiToolStatusSchema.optional(),
  codexLogin: z
    .object({
      running: z.boolean().optional(),
      lastExit: z
        .object({ code: z.number().nullable(), signal: z.string().nullable() })
        .nullable()
        .optional(),
      lastError: z.string().nullable().optional(),
    })
    .optional(),
  codexDeviceLogin: z
    .object({
      running: z.boolean().optional(),
      userCode: z.string().nullable().optional(),
      verificationUrl: z.string().nullable().optional(),
      lastError: z.string().nullable().optional(),
    })
    .optional(),
  anthropicCompatible: anthropicCompatibleCredentialsSummarySchema
    .nullable()
    .optional()
    .catch(null),
});
export type UsageWindowStatus = z.infer<typeof usageWindowStatusSchema>;
export type AIToolUsageStatus = z.infer<typeof aiToolUsageStatusSchema>;
export type AIToolStatus = z.infer<typeof aiToolStatusSchema>;
export type AIToolsStatus = z.infer<typeof aiToolsStatusSchema>;
export type AIToolProviderId = "openai" | "anthropic";

export function claudeUsesApiKey(state: Pick<AIToolStatus, "authMethod">): boolean {
  return state.authMethod === "stored-compatible" || state.authMethod === "environment";
}

/** Unknown login is optimistic, as during the initial probes. */
export function autoModelProvider(
  codex: Pick<AIToolStatus, "loggedIn" | "quotaExhausted"> | null,
  claude: Pick<AIToolStatus, "loggedIn" | "quotaExhausted" | "authMethod"> | null,
): AIToolProviderId | null {
  if (codex && codex.loggedIn !== false && !codex.quotaExhausted) return "openai";
  if (claude && claude.loggedIn !== false && (!claude.quotaExhausted || claudeUsesApiKey(claude)))
    return "anthropic";
  return null;
}
