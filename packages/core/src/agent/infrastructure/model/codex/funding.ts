import type { ModelFunding } from "../../../domain/model-port.js";
import type { CodexLogin } from "../../../domain/model-login.js";

/**
 * Funding for a Codex turn. The login decides first: Rome credits bill the
 * account's credits. Otherwise the cached Codex account type decides, and an
 * account not yet probed is `unknown`.
 */
export function codexFunding(params: {
  login: CodexLogin;
  accountType: string | undefined;
  loggedIn: boolean | undefined;
}): ModelFunding {
  if (params.login.kind === "rome_credits") return "rome_credits";
  if (params.accountType === "api_key") return "byok";
  if (params.loggedIn && params.accountType) return "subscription";
  return "unknown";
}
