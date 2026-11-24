// Static fallback for the agent domain's selections. lint/model-selection-catalog.test.ts
// checks wire identities and labels without a provider login or a discovery process.
export const LARGE_MODEL_OPTIONS = [
  { id: "auto", labelKey: "modelSelector.options.auto", providerId: null, model: null },
  {
    id: "claude-opus",
    labelKey: "modelSelector.options.claudeOpus",
    providerId: "anthropic",
    model: "claude-opus-4-8[1m]",
  },
  {
    id: "claude-opus-5-5",
    labelKey: "modelSelector.options.opus55",
    providerId: "anthropic",
    model: "claude-opus-5-5[1m]",
  },
  {
    id: "claude-opus-5",
    labelKey: "modelSelector.options.opus5",
    providerId: "anthropic",
    model: "claude-opus-5[1m]",
  },
  {
    id: "claude-opus-4-6",
    labelKey: "modelSelector.options.opus46",
    providerId: "anthropic",
    model: "claude-opus-4-6[1m]",
  },
  {
    id: "claude-sonnet",
    labelKey: "modelSelector.options.sonnet",
    providerId: "anthropic",
    model: "claude-sonnet-5-5",
  },
  {
    id: "claude-haiku",
    labelKey: "modelSelector.options.haiku",
    providerId: "anthropic",
    model: "claude-haiku-5-5",
  },
  {
    id: "claude-fable",
    labelKey: "modelSelector.options.fable",
    providerId: "anthropic",
    model: "claude-fable-5-1[1m]",
  },
  {
    id: "gpt-6-astra",
    labelKey: "modelSelector.options.gpt6Astra",
    providerId: "openai",
    model: "gpt-6-astra",
  },
  {
    id: "gpt-6-1-sol",
    labelKey: "modelSelector.options.gpt61Sol",
    providerId: "openai",
    model: "gpt-6.1-sol",
  },
  {
    id: "gpt-6-sol",
    labelKey: "modelSelector.options.gpt6Sol",
    providerId: "openai",
    model: "gpt-6-sol",
  },
  {
    id: "gpt-6-luna",
    labelKey: "modelSelector.options.gpt6Luna",
    providerId: "openai",
    model: "gpt-6-luna",
  },
  {
    id: "gpt-5-6-sol",
    labelKey: "modelSelector.options.gpt56Sol",
    providerId: "openai",
    model: "gpt-5.6-sol",
  },
  {
    id: "gpt-5-6-terra",
    labelKey: "modelSelector.options.gpt56Terra",
    providerId: "openai",
    model: "gpt-5.6-terra",
  },
  {
    id: "gpt-5-6-luna",
    labelKey: "modelSelector.options.gpt56Luna",
    providerId: "openai",
    model: "gpt-5.6-luna",
  },
] as const;

/** Keeps one row per provider and exact wire id, preferring the stored selection.
 * Versions, context suffixes, and unresolved provider aliases stay distinct. */
export function distinctModelOptions<
  T extends {
    id: string;
    providerId: string | null;
    model: string | null;
  },
>(options: readonly T[], selected: string): T[] {
  const byModel = new Map<string, T>();
  for (const option of options) {
    const key = JSON.stringify([option.providerId, option.model ?? option.id]);
    if (!byModel.has(key) || option.id === selected) byModel.set(key, option);
  }
  return [...byModel.values()];
}
