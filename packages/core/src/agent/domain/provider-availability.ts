// Model provider availability: whether a run can use a provider now, read from
// the login in effect. Rome credits make Codex available, whatever the
// guardian's account says. docs/domains/agents.md carries the language.

import type { ModelAccountReport, ProviderAvailabilityState } from "./model-account-report.js";
import type { CodexLogin } from "./model-login.js";

/** A provider Rome has not read yet reads as available. */
export function providerAvailability(
  report: ModelAccountReport | undefined,
  login: CodexLogin | undefined,
): ProviderAvailabilityState {
  if (login?.kind === "rome_credits") return "available";
  return report?.state ?? "available";
}
