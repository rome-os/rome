// Where a chat moves when one model hits its own limit: a different model of
// the same provider. Rome never moves a chat to another provider on its own
// (docs/adrs/default-provider-over-automatic-failover.md). Neither Rome credits
// nor ChatGPT credits may fund the move.

import { CODEX_LUNA_MODEL } from "./model-selection.js";
import { codexFastSelection } from "./model-strength.js";
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

/** The account's usage is limited by a subscription. An unread or per-use account is not. */
function subscription(report: ModelAccountReport | undefined): boolean {
  return report !== undefined && report.account.usageLimited !== false;
}

const codexSmallSelection = (codex: ModelAccountReport): ModelSelectionId =>
  codexFastSelection(codex.account);

/** A different model of the same provider when it is available and the chat's model hit a limit. */
export function sameProviderTarget(
  state: ModelAccountReports,
  from: SwitchableProviderId,
  model: string,
): UsageSwitchTarget | null {
  const source = state[from];
  if (
    !source ||
    source.state !== "available" ||
    !subscription(source) ||
    source.requiresChatgptCredits
  )
    return null;
  let selectionId: ModelSelectionId;
  if (from === "anthropic") {
    if (/sonnet/.test(model)) selectionId = "anthropic/claude-opus-5-5[1m]";
    else if (/opus|fable|haiku/.test(model)) selectionId = "anthropic/claude-sonnet-5-5";
    else return null;
  } else if (/luna/.test(model)) selectionId = "openai/gpt-5.6-terra";
  else if (/terra/.test(model)) {
    if (!accountAllowsModel(source.account, CODEX_LUNA_MODEL)) return null;
    selectionId = "openai/gpt-6-luna";
  } else if (/sol|astra/.test(model)) selectionId = codexSmallSelection(source);
  else return null;
  return { provider: from, selectionId };
}
