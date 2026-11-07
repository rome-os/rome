// Shared Codex helpers — model catalog, env/auth wiring, and OpenAI-shaped
// accounting. Consumed by CodexAppServerProvider (the only Codex provider).

import type { AgentStop } from "../../../../types.js";
import {
  buildAgentAccounting,
  calculateImpliedCostUsd,
} from "../../../../core/provider-accounting.js";
import { stripLegacyReasoningSuffix } from "../../../../core/model-alias.js";

/** Token usage for a Codex turn. Mirrors the shape codex emits over the
 *  app-server protocol. */
export type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

// Env vars Codex and its child commands need. Everything else stays in
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

interface BuildOpenAiAccountingArgs {
  usage: Usage | undefined;
  model: string;
  reportedCostUsd?: number;
  stop?: AgentStop;
  stopReason?: string;
  durationMs?: number;
}

function normalizeOpenAiUsage(usage: Usage | undefined) {
  const sdkInputTokens = usage?.input_tokens ?? 0;
  const cacheReadTokens = usage?.cached_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_write_input_tokens ?? 0;
  const inputTokens = Math.max(0, sdkInputTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = usage?.output_tokens ?? 0;
  const reportedReasoningTokens = usage?.reasoning_output_tokens;
  const reasoningTokens = reportedReasoningTokens ?? 0;
  return {
    agentUsage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(typeof reportedReasoningTokens === "number" && Number.isFinite(reportedReasoningTokens)
        ? { reasoningTokens: reportedReasoningTokens }
        : {}),
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

  return buildAgentAccounting({
    provider: "openai",
    model: stripLegacyReasoningSuffix(args.model),
    usage: normalized.agentUsage,
    reportedCostUsd: args.reportedCostUsd,
    stop: args.stop,
    stopReason: args.stopReason,
    durationMs: args.durationMs,
    rawUsage: normalized.rawUsage,
  });
}
