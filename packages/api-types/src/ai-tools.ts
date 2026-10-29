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

export const usageWindowStatusSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100).optional(),
  remainingPercent: z.number().finite().min(0).max(100).optional(),
  resetsAt: z.string().optional(),
});
export const aiToolUsageStatusSchema = z.object({
  checkedAt: z.string(),
  source: z.string(),
  fiveHour: usageWindowStatusSchema.optional(),
  sevenDay: usageWindowStatusSchema.optional(),
  error: z.string().optional(),
});
export const aiToolStatusSchema = z.object({
  solAccess: z.boolean().optional(),
  lunaAccess: z.boolean().optional(),
  anthropicCompatible: anthropicCompatibleCredentialsSummarySchema.nullable().optional(),
  loggedIn: z.boolean().optional(),
  quotaExhausted: z.boolean().optional(),
  quotaExhaustedUntil: z.string().optional(),
  email: z.string().optional(),
  authMethod: z.string().optional(),
  accountType: z.string().optional(),
  needsReauth: z.boolean().optional(),
  usage: aiToolUsageStatusSchema.optional(),
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
  anthropicCompatible: anthropicCompatibleCredentialsSummarySchema.nullable().optional(),
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
