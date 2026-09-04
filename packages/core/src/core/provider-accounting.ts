import type { AgentAccounting, AgentContextUsage, AgentTokenUsage } from "../types.js";

interface TokenRates {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
}

interface PricingRule {
  provider: string;
  matchesModel: (model: string) => boolean;
  resolveRates: (rawUsage?: Record<string, unknown>) => TokenRates;
}

interface BuildAgentAccountingParams {
  provider: string;
  model: string;
  usage: AgentTokenUsage;
  reportedCostUsd?: number;
  numTurns?: number;
  stopReason?: string;
  durationMs?: number;
  rawUsage?: Record<string, unknown>;
  context?: AgentContextUsage;
}

const ANTHROPIC_5_MINUTE_CACHE_WRITE_MULTIPLIER = 1.25;
const ANTHROPIC_1_HOUR_CACHE_WRITE_MULTIPLIER = 2;
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
const OPENAI_CACHE_READ_MULTIPLIER = 0.1;
const OPENAI_CACHE_WRITE_MULTIPLIER = 1.25;
const OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
const OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER = 2;
const OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;

function hasPrefix(model: string, prefix: string): boolean {
  return model.toLowerCase().startsWith(prefix.toLowerCase());
}

function matchesModelAlias(model: string, baseModel: string): boolean {
  const normalizedModel = model.toLowerCase();
  const normalizedBaseModel = baseModel.toLowerCase();
  if (
    normalizedModel === normalizedBaseModel ||
    normalizedModel.startsWith(`${normalizedBaseModel}:`)
  ) {
    return true;
  }

  const snapshotSuffix = normalizedModel.slice(`${normalizedBaseModel}-`.length);
  return (
    normalizedModel.startsWith(`${normalizedBaseModel}-`) &&
    /^\d{4}-\d{2}-\d{2}(?::.+)?$/.test(snapshotSuffix)
  );
}

function anthropicRates(baseInputUsdPerMillion: number, outputUsdPerMillion: number): TokenRates {
  return {
    inputUsdPerMillion: baseInputUsdPerMillion,
    outputUsdPerMillion,
    cacheReadUsdPerMillion: baseInputUsdPerMillion * ANTHROPIC_CACHE_READ_MULTIPLIER,
    cacheWriteUsdPerMillion: baseInputUsdPerMillion * ANTHROPIC_5_MINUTE_CACHE_WRITE_MULTIPLIER,
  };
}

function getAnthropicCacheWriteMultiplier(rawUsage?: Record<string, unknown>): number {
  const ttlSeconds = rawUsage?.cache_write_ttl_seconds;
  if (typeof ttlSeconds === "number" && ttlSeconds >= 3600) {
    return ANTHROPIC_1_HOUR_CACHE_WRITE_MULTIPLIER;
  }
  return ANTHROPIC_5_MINUTE_CACHE_WRITE_MULTIPLIER;
}

// OpenAI's Codex-era rate card: cache reads at 0.1x and cache writes at
// 1.25x the input rate, with the whole request billed at long-context
// multipliers once the prompt passes 272K input tokens. GPT-5.6 and GPT-6
// publish the same rules, so one helper serves both generations.
function openAiLongContextRates(
  inputUsdPerMillion: number,
  outputUsdPerMillion: number,
  rawUsage?: Record<string, unknown>,
): TokenRates {
  const rawInputTokens = rawUsage?.input_tokens;
  const isLongContext =
    typeof rawInputTokens === "number" && rawInputTokens > OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS;
  const inputMultiplier = isLongContext ? OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER : 1;
  const outputMultiplier = isLongContext ? OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER : 1;

  return {
    inputUsdPerMillion: inputUsdPerMillion * inputMultiplier,
    outputUsdPerMillion: outputUsdPerMillion * outputMultiplier,
    cacheReadUsdPerMillion: inputUsdPerMillion * OPENAI_CACHE_READ_MULTIPLIER * inputMultiplier,
    cacheWriteUsdPerMillion: inputUsdPerMillion * OPENAI_CACHE_WRITE_MULTIPLIER * inputMultiplier,
  };
}

const PRICING_RULES: PricingRule[] = [
  {
    provider: "anthropic",
    // Fable 5.1 discounts cache reads to 0.025x the input rate; every other
    // Anthropic model reads at 0.1x.
    matchesModel: (model) => hasPrefix(model, "claude-fable-5-1"),
    resolveRates: (rawUsage) => ({
      inputUsdPerMillion: 10,
      outputUsdPerMillion: 50,
      cacheReadUsdPerMillion: 0.25,
      cacheWriteUsdPerMillion: 10 * getAnthropicCacheWriteMultiplier(rawUsage),
    }),
  },
  {
    provider: "anthropic",
    matchesModel: (model) => hasPrefix(model, "claude-fable-5[1m]"),
    resolveRates: (rawUsage) => ({
      inputUsdPerMillion: 10,
      outputUsdPerMillion: 50,
      cacheReadUsdPerMillion: 1,
      cacheWriteUsdPerMillion: 10 * getAnthropicCacheWriteMultiplier(rawUsage),
    }),
  },
  {
    provider: "anthropic",
    matchesModel: (model) =>
      hasPrefix(model, "claude-opus-5") ||
      hasPrefix(model, "claude-opus-4-8") ||
      hasPrefix(model, "claude-opus-4-6"),
    resolveRates: (rawUsage) => ({
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 5 * getAnthropicCacheWriteMultiplier(rawUsage),
    }),
  },
  {
    provider: "anthropic",
    matchesModel: (model) =>
      hasPrefix(model, "claude-sonnet-5") ||
      hasPrefix(model, "claude-sonnet-4-6") ||
      hasPrefix(model, "claude-sonnet-4-5") ||
      model.toLowerCase() === "claude-sonnet-4",
    resolveRates: (rawUsage) => ({
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.3,
      cacheWriteUsdPerMillion: 3 * getAnthropicCacheWriteMultiplier(rawUsage),
    }),
  },
  {
    provider: "anthropic",
    matchesModel: (model) => hasPrefix(model, "claude-haiku-4-5"),
    resolveRates: (rawUsage) => ({
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.1,
      cacheWriteUsdPerMillion: 1 * getAnthropicCacheWriteMultiplier(rawUsage),
    }),
  },
  {
    provider: "anthropic",
    matchesModel: (model) => matchesModelAlias(model, "muse-spark-1.1"),
    resolveRates: () => ({
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 4.25,
      cacheReadUsdPerMillion: 0.15,
      cacheWriteUsdPerMillion: 1.25,
    }),
  },
  // Codex via the ChatGPT-account auth path. Older `:effort`
  // suffixed Codex aliases are kept in the matcher for compatibility with
  // previously recorded rows.
  {
    provider: "openai",
    matchesModel: (model) => matchesModelAlias(model, "gpt-6-astra"),
    resolveRates: (rawUsage) => openAiLongContextRates(10, 50, rawUsage),
  },
  {
    provider: "openai",
    matchesModel: (model) =>
      matchesModelAlias(model, "gpt-5.6-sol") || matchesModelAlias(model, "gpt-5.6"),
    resolveRates: (rawUsage) => openAiLongContextRates(5, 30, rawUsage),
  },
  {
    provider: "openai",
    matchesModel: (model) => matchesModelAlias(model, "gpt-5.6-terra"),
    resolveRates: (rawUsage) => openAiLongContextRates(2.5, 15, rawUsage),
  },
  {
    provider: "openai",
    matchesModel: (model) => matchesModelAlias(model, "gpt-5.6-luna"),
    resolveRates: (rawUsage) => openAiLongContextRates(1, 6, rawUsage),
  },
  {
    provider: "openai",
    matchesModel: (model) => matchesModelAlias(model, "gpt-5.5"),
    resolveRates: () => ({
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 0,
    }),
  },
  {
    provider: "openai",
    matchesModel: (model) => matchesModelAlias(model, "gpt-5.4-mini"),
    resolveRates: () => ({
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 4.5,
      cacheReadUsdPerMillion: 0.075,
      cacheWriteUsdPerMillion: 0,
    }),
  },
  {
    provider: "openai",
    matchesModel: (model) => matchesModelAlias(model, "gpt-5.4"),
    resolveRates: () => ({
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.25,
      cacheWriteUsdPerMillion: 0,
    }),
  },
  {
    provider: "openai",
    matchesModel: (model) => hasPrefix(model, "gpt-5.3-codex"),
    resolveRates: () => ({
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 10,
      cacheReadUsdPerMillion: 0.125,
      cacheWriteUsdPerMillion: 0,
    }),
  },
];

function costForTokens(tokens: number, usdPerMillion: number): number {
  return (tokens * usdPerMillion) / 1_000_000;
}

function resolveTokenRates(
  provider: string,
  model: string,
  rawUsage?: Record<string, unknown>,
): TokenRates | undefined {
  return PRICING_RULES.find(
    (rule) => rule.provider === provider && rule.matchesModel(model),
  )?.resolveRates(rawUsage);
}

export function calculateImpliedCostUsd(
  provider: string,
  model: string,
  usage: AgentTokenUsage,
  rawUsage?: Record<string, unknown>,
): number | undefined {
  const rates = resolveTokenRates(provider, model, rawUsage);
  if (!rates) {
    return undefined;
  }

  return (
    costForTokens(usage.inputTokens, rates.inputUsdPerMillion) +
    costForTokens(usage.outputTokens, rates.outputUsdPerMillion) +
    costForTokens(usage.cacheReadTokens, rates.cacheReadUsdPerMillion) +
    costForTokens(usage.cacheWriteTokens, rates.cacheWriteUsdPerMillion)
  );
}

export function buildAgentAccounting(params: BuildAgentAccountingParams): AgentAccounting {
  const impliedCostUsd = calculateImpliedCostUsd(
    params.provider,
    params.model,
    params.usage,
    params.rawUsage,
  );

  return {
    provider: params.provider,
    model: params.model,
    usage: params.usage,
    context: params.context,
    costUsd: params.reportedCostUsd ?? impliedCostUsd,
    numTurns: params.numTurns,
    stopReason: params.stopReason,
    durationMs: params.durationMs,
    rawUsage: params.rawUsage,
  };
}

export { anthropicRates };
