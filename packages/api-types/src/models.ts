// Fixed execution identities shared by clients and core. Display names never route requests.
export interface ModelIdentity {
  providerId: string;
  modelId: string;
}

/** An opaque native ID qualified by its provider; only the first slash is structural. */
export function modelIdentityKey(identity: ModelIdentity): string {
  if (!identity.providerId || /[\s/]/u.test(identity.providerId) || !identity.modelId) {
    throw new Error("A model identity needs a provider and complete native ID");
  }
  return `${identity.providerId}/${identity.modelId}`;
}

export const MODEL_CATALOG = [
  {
    id: "anthropic/claude-opus-4-8[1m]",
    providerId: "anthropic",
    modelId: "claude-opus-4-8[1m]",
    name: "Opus 4.8",
  },
  {
    id: "anthropic/claude-opus-5-5[1m]",
    providerId: "anthropic",
    modelId: "claude-opus-5-5[1m]",
    name: "Opus 5.5",
  },
  {
    id: "anthropic/claude-opus-5[1m]",
    providerId: "anthropic",
    modelId: "claude-opus-5[1m]",
    name: "Opus 5",
  },
  {
    id: "anthropic/claude-opus-4-6[1m]",
    providerId: "anthropic",
    modelId: "claude-opus-4-6[1m]",
    name: "Opus 4.6",
  },
  {
    id: "anthropic/claude-sonnet-5-5",
    providerId: "anthropic",
    modelId: "claude-sonnet-5-5",
    name: "Sonnet 5.5",
  },
  {
    id: "anthropic/claude-haiku-5-5",
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    name: "Haiku 5.5",
  },
  {
    id: "anthropic/claude-fable-5-1[1m]",
    providerId: "anthropic",
    modelId: "claude-fable-5-1[1m]",
    name: "Fable 5.1",
  },
  { id: "openai/gpt-6-astra", providerId: "openai", modelId: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "openai/gpt-6.1-sol", providerId: "openai", modelId: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { id: "openai/gpt-6-sol", providerId: "openai", modelId: "gpt-6-sol", name: "GPT-6 Sol" },
  { id: "openai/gpt-6-luna", providerId: "openai", modelId: "gpt-6-luna", name: "GPT-6 Luna" },
  { id: "openai/gpt-5.6-sol", providerId: "openai", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  {
    id: "openai/gpt-5.6-terra",
    providerId: "openai",
    modelId: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
  },
  {
    id: "openai/gpt-5.6-luna",
    providerId: "openai",
    modelId: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
  },
] as const;

export type ModelSelectionId = (typeof MODEL_CATALOG)[number]["id"];
export const LEGACY_MODEL_SELECTIONS = {
  "claude-opus": "anthropic/claude-opus-4-8[1m]",
  "claude-opus-5-5": "anthropic/claude-opus-5-5[1m]",
  "claude-opus-5": "anthropic/claude-opus-5[1m]",
  "claude-opus-4-6": "anthropic/claude-opus-4-6[1m]",
  "claude-sonnet": "anthropic/claude-sonnet-5-5",
  "claude-haiku": "anthropic/claude-haiku-5-5",
  "claude-fable": "anthropic/claude-fable-5-1[1m]",
  "gpt-6-astra": "openai/gpt-6-astra",
  "gpt-6-1-sol": "openai/gpt-6.1-sol",
  "gpt-6-sol": "openai/gpt-6-sol",
  "gpt-6-luna": "openai/gpt-6-luna",
  "gpt-5-6-sol": "openai/gpt-5.6-sol",
  "gpt-5-6-terra": "openai/gpt-5.6-terra",
  "gpt-5-6-luna": "openai/gpt-5.6-luna",
} as const satisfies Record<string, ModelSelectionId>;

export function isModelSelectionId(value: unknown): value is ModelSelectionId {
  return typeof value === "string" && MODEL_CATALOG.some((entry) => entry.id === value);
}

/** Read-only compatibility for saved choices, never a floating alias resolver. */
export function canonicalModelSelection(value: unknown): ModelSelectionId | null {
  if (isModelSelectionId(value)) return value;
  return typeof value === "string" && Object.hasOwn(LEGACY_MODEL_SELECTIONS, value)
    ? LEGACY_MODEL_SELECTIONS[value as keyof typeof LEGACY_MODEL_SELECTIONS]
    : null;
}

// Extra concrete historical names are display-only, not selectable aliases.
const HISTORICAL_MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-opus-5": "Opus 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-5": "Sonnet 5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-fable-5-1": "Fable 5.1",
  "claude-fable-5[1m]": "Fable 5",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
};

export function modelDisplayName(modelId: string): string {
  return (
    MODEL_CATALOG.find((entry) => entry.modelId === modelId)?.name ??
    HISTORICAL_MODEL_NAMES[modelId] ??
    modelId
  );
}

/** Read legacy choices only at input boundaries. Unknown choices never become Auto. */
export function readModelSelectionInput(value: unknown): ModelSelectionId | "auto" | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") return value;
  const id = canonicalModelSelection(value);
  if (!id) throw new Error("A known fixed model selection is required");
  return id;
}
