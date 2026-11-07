// Where a chat moves when its provider reaches its usage limit: the other
// provider when it can take the turn, else a different model of the same one.
// Read off raw availability: the resolver's own view can include Rome credits,
// which must not be spent on recovery.

import { CODEX_LUNA_MODEL } from "./model-selection.js";
import type { ModelSelectionId } from "./model-selection.js";
import {
  accountAllowsModel,
  type AccountedProviderId,
  type ModelAccountReports,
  type ModelAccountReport,
} from "./model-account-report.js";

export type SwitchableProviderId = AccountedProviderId;

export interface UsageSwitchTarget {
  provider: SwitchableProviderId;
  selectionId: ModelSelectionId;
}

function atUsageLimit(report: ModelAccountReport | undefined): boolean {
  return report?.state === "usage_limit_reached";
}

/** The account's usage is limited by a subscription. An unread or per-use account is not. */
function subscription(report: ModelAccountReport | undefined): boolean {
  return report !== undefined && report.account.usageLimited !== false;
}

/** The one provider at its usage limit while the other is not, or null. */
export function soleProviderAtUsageLimit(state: ModelAccountReports): SwitchableProviderId | null {
  const codex = atUsageLimit(state.openai);
  const claude = atUsageLimit(state.anthropic);
  if (codex === claude) return null;
  return codex ? "openai" : "anthropic";
}

function codexSmallSelection(codex: ModelAccountReport): ModelSelectionId {
  return accountAllowsModel(codex.account, CODEX_LUNA_MODEL) ? "gpt-6-luna" : "gpt-5-6-terra";
}

/**
 * The other provider's selection when `from` is at its limit (or `failed`
 * says its turn just was) and the other is an available subscription. A
 * source Rome has not read is taken at the failure's word: the refusal says
 * it is a subscription at its limit.
 */
export function usageSwitchTarget(
  state: ModelAccountReports,
  from: SwitchableProviderId,
  failed = false,
): UsageSwitchTarget | null {
  const source = state[from];
  if (source ? !subscription(source) : !failed) return null;
  if (!failed && !atUsageLimit(source)) return null;
  const provider: SwitchableProviderId = from === "openai" ? "anthropic" : "openai";
  const target = state[provider];
  if (!target || target.state !== "available" || !subscription(target)) return null;
  if (provider === "anthropic") return { provider, selectionId: "claude-sonnet" };
  return { provider, selectionId: codexSmallSelection(target) };
}

/** A different model of the same provider when it is available and the chat's model hit a limit. */
export function sameProviderTarget(
  state: ModelAccountReports,
  from: SwitchableProviderId,
  model: string,
): UsageSwitchTarget | null {
  const source = state[from];
  if (!source || source.state !== "available" || !subscription(source)) return null;
  let selectionId: ModelSelectionId;
  if (from === "anthropic") {
    if (/sonnet/.test(model)) selectionId = "claude-opus-5-5";
    else if (/opus|fable|haiku/.test(model)) selectionId = "claude-sonnet";
    else return null;
  } else if (/luna/.test(model)) selectionId = "gpt-5-6-terra";
  else if (/terra/.test(model)) {
    if (!accountAllowsModel(source.account, CODEX_LUNA_MODEL)) return null;
    selectionId = "gpt-6-luna";
  } else if (/sol|astra/.test(model)) selectionId = codexSmallSelection(source);
  else return null;
  return { provider: from, selectionId };
}
