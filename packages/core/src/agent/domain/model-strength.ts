// How strong a model a chat runs on, per provider: fast is the provider's
// quick model, strong its best. The Concierge runs strong, and picks one of
// the two for each task chat it starts. docs/domains/agents.md#model-strength

import { CODEX_LUNA_MODEL, CODEX_SOL_MODEL, type ModelSelectionId } from "./model-selection.js";
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
