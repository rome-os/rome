import type { ModelFunding } from "../../../domain/model-port.js";
import type { CodexLogin } from "../../../domain/model-login.js";

/**
 * Funding for a Codex turn. The login decides: Rome credits bill the account's
 * credits and an API credential the guardian's own key. An account not yet
 * probed is `unknown`.
 */
export function codexFunding(params: {
  login: CodexLogin;
  accountType: string | undefined;
  loggedIn: boolean | undefined;
}): ModelFunding {
  if (params.login.kind === "rome_credits") return "rome_credits";
  if (params.login.kind === "api_credential") return "byok";
  if (params.loggedIn && params.accountType) return "subscription";
  return "unknown";
}
