// How strong a model a chat runs on, per provider: fast is the provider's
// quick model, strong its best. The Concierge runs strong, and picks one of
// the two for each task chat it starts. docs/domains/agents.md#model-strength

import {
  CODEX_LUNA_MODEL,
  CODEX_SOL_MODEL,
  MODEL_SELECTIONS,
  type ModelSelectionId,
} from "./model-selection.js";
import { providerOfDefault, type DefaultProvider } from "./default-provider.js";
import { accountAllowsModel, type ModelAccountReport } from "./model-account-report.js";

export type ModelStrength = "fast" | "strong";

/** Codex's quick model the account may use: Luna, else Terra. */
export function codexFastSelection(account: ModelAccountReport["account"]): ModelSelectionId {
  return accountAllowsModel(account, CODEX_LUNA_MODEL) ? "gpt-6-luna" : "gpt-5-6-terra";
}

/** Codex's strongest model the account may use: Sol, else Terra. */
export function codexStrongSelection(account: ModelAccountReport["account"]): ModelSelectionId {
  return accountAllowsModel(account, CODEX_SOL_MODEL) ? "gpt-6-1-sol" : "gpt-5-6-terra";
}

/** The model of `strength` on a provider: Sonnet or Opus on Claude, by the account on Codex. */
export function selectionOfStrength(
  provider: "anthropic" | "openai",
  strength: ModelStrength,
  codexAccount?: ModelAccountReport["account"],
): ModelSelectionId {
  if (provider === "anthropic") return strength === "fast" ? "claude-sonnet" : "claude-opus-5-5";
  if (!codexAccount) return strength === "fast" ? "gpt-6-luna" : "gpt-6-1-sol";
  return strength === "fast"
    ? codexFastSelection(codexAccount)
    : codexStrongSelection(codexAccount);
}

/**
 * How strong a selection is: each provider's quick models are fast, the rest
 * strong. Terra is Codex's strong model for an account whose plan withholds
 * Sol, so it counts as strong there.
 */
export function strengthOfSelection(
  id: ModelSelectionId,
  codexAccount?: ModelAccountReport["account"],
): ModelStrength {
  if (id === "gpt-5-6-terra" && codexAccount && codexStrongSelection(codexAccount) === id) {
    return "strong";
  }
  return /sonnet|haiku|luna|terra/.test(id) ? "fast" : "strong";
}

/**
 * The model a chat that follows the default runs: its stored model while that
 * is on the default provider, else the default provider's model of the same
 * strength. With no default, the stored model stays.
 */
export function followingSelection(
  stored: ModelSelectionId,
  defaultProvider: DefaultProvider | null,
  codexAccount?: ModelAccountReport["account"],
): ModelSelectionId {
  if (!defaultProvider) return stored;
  const provider = providerOfDefault(defaultProvider);
  if (MODEL_SELECTIONS[stored].providerId === provider) return stored;
  return selectionOfStrength(provider, strengthOfSelection(stored, codexAccount), codexAccount);
}
