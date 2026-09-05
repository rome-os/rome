// Shared Codex helpers — model catalog, env/auth wiring, and OpenAI-shaped
// accounting. Consumed by CodexAppServerProvider (the only Codex provider).

import { buildAgentAccounting, calculateImpliedCostUsd } from "../provider-accounting.js";
import {
  modelTokenMetricAttributes,
  modelTurnDurationMetric,
  modelTokensMetric,
} from "../../telemetry.js";

/** Token usage for a Codex turn. Mirrors the shape codex emits over the
 *  app-server protocol. */
export type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

// Env vars the codex Rust binary actually needs. Everything else stays in
// Rome's process so we don't leak secrets into the subprocess.
export const CODEX_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

export function stripLegacyReasoningSuffix(model: string): string {
  const idx = model.lastIndexOf(":");
  if (idx >= 0) {
    const suffix = model.slice(idx + 1);
    if (suffix === "low" || suffix === "medium" || suffix === "high") {
      return model.slice(0, idx);
    }
  }
  return model;
}

interface BuildOpenAiAccountingArgs {
  usage: Usage | undefined;
  model: string;
  agentName?: string;
  appStoreListingId?: string;
  reportedCostUsd?: number;
  stopReason?: string;
  durationMs?: number;
}

function normalizeOpenAiUsage(usage: Usage | undefined) {
  const sdkInputTokens = usage?.input_tokens ?? 0;
  const cacheReadTokens = usage?.cached_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_write_input_tokens ?? 0;
  const inputTokens = Math.max(0, sdkInputTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = usage?.output_tokens ?? 0;
  const reasoningTokens = usage?.reasoning_output_tokens ?? 0;
  return {
    sdkInputTokens,
    outputTokens,
    agentUsage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    },
    rawUsage: usage
      ? {
          input_tokens: sdkInputTokens,
          uncached_input_tokens: inputTokens,
          output_tokens: outputTokens,
          cached_tokens: cacheReadTokens,
          cache_write_tokens: cacheWriteTokens,
          reasoning_tokens: reasoningTokens,
        }
      : undefined,
  };
}

/** Price one Codex model request before turn-level usage is aggregated. */
export function calculateOpenAiCostUsd(usage: Usage | undefined, model: string) {
  if (!usage) return undefined;
  const normalized = normalizeOpenAiUsage(usage);
  return calculateImpliedCostUsd(
    "openai",
    stripLegacyReasoningSuffix(model),
    normalized.agentUsage,
    normalized.rawUsage,
  );
}

export function buildOpenAiAccounting(args: BuildOpenAiAccountingArgs) {
  const normalized = normalizeOpenAiUsage(args.usage);

  const accounting = buildAgentAccounting({
    provider: "openai",
    model: stripLegacyReasoningSuffix(args.model),
    usage: normalized.agentUsage,
    reportedCostUsd: args.reportedCostUsd,
    stopReason: args.stopReason,
    durationMs: args.durationMs,
    rawUsage: normalized.rawUsage,
  });

  if (accounting?.usage) {
    const modelName = stripLegacyReasoningSuffix(args.model);
    if (typeof args.durationMs === "number" && Number.isFinite(args.durationMs)) {
      modelTurnDurationMetric().record(args.durationMs, { model: modelName });
    }
    const tokens = modelTokensMetric();
    if (normalized.sdkInputTokens > 0)
      tokens.add(
        normalized.sdkInputTokens,
        modelTokenMetricAttributes(modelName, "in", {
          agentName: args.agentName,
          appStoreListingId: args.appStoreListingId,
        }),
      );
    if (normalized.outputTokens > 0)
      tokens.add(
        normalized.outputTokens,
        modelTokenMetricAttributes(modelName, "out", {
          agentName: args.agentName,
          appStoreListingId: args.appStoreListingId,
        }),
      );
  }

  return accounting;
}
