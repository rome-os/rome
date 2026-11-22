import type { AgentTurnFailure } from "@rome-os/app-runtime";
import type { QuotaSwitchPart } from "@rome/api-types/chat";
import { providerAuthorized, type ModelAccountReports } from "./model-account-report.js";

export type FailoverReason = NonNullable<QuotaSwitchPart["reason"]>;

export function ambiguousQuota(message: string): boolean {
  return /you(?:'ve| have) hit your limit\b/i.test(message);
}

/** Classifies only subscription failures. Wording overrides a generic rate-limit kind. */
export function failoverReason(
  failure: AgentTurnFailure | undefined,
  state: ModelAccountReports,
): FailoverReason | null {
  if (!failure || (failure.provider !== "openai" && failure.provider !== "anthropic")) return null;
  const { message, code, reason, httpStatus, providerError } = failure;
  const report = state[failure.provider];
  // An account billed per use has no subscription to fail over from.
  if (report?.account.usageLimited === false) return null;
  // Codex runs on Rome credits while the ChatGPT account is out, and recovery must not spend them.
  if (
    failure.provider === "openai" &&
    !providerAuthorized(report) &&
    code !== "auth_revoked" &&
    code !== "credits_used_up" &&
    reason !== "not_logged_in"
  )
    return null;
  if (code === "model_unavailable" || reason === "model_access_denied") return "model_limit";
  if (
    code === "context_window_exceeded" ||
    code === "invalid_request" ||
    httpStatus === 400 ||
    providerError === "invalid_request" ||
    providerError === "max_output_tokens" ||
    /prompt[_ ](?:is[_ ])?too[_ ]long|context[_ ](?:window[_ ])?(?:exceeded|too long)|max[_ -](?:output[_ -])?tokens|content refusal|content policy|\brefusal\b|user.*(?:stop|interrupt)|(?:stop|interrupt).*user|turn interrupted|rome (?:is )?(?:restart|shut)|structured[ -]output|submit_output|maximum number of turns|max_turns|credit balance is too low|process exited with code/i.test(
      message,
    )
  )
    return null;
  if (
    code === "usage_limit" ||
    code === "credits_used_up" ||
    reason === "quota_exhausted" ||
    ambiguousQuota(message) ||
    /out of usage credits|(?:monthly )?spend(?:ing)? limit|team['’]s shared budget|hit your (?:session|weekly) limit|(?<!not your )usage limit/i.test(
      message,
    ) ||
    providerError === "billing_error"
  )
    return "quota";
  if (
    code === "auth_revoked" ||
    reason === "not_logged_in" ||
    httpStatus === 401 ||
    httpStatus === 403 ||
    /authentication_failed|oauth_org_not_allowed|account_on_hold|verification_required|cloud_credential_error/.test(
      providerError ?? "",
    ) ||
    /failed to authenticate|oauth session expired|\b(?:status|error):?\s*(?:401|403)\b/i.test(
      message,
    ) ||
    report?.state === "expired"
  )
    return "login";
  if (
    providerError === "model_not_found" ||
    /(?:sonnet|opus|fable(?: \d+)?|haiku) limit|selected model is at capacity|issue with the selected model|model.*(?:does not exist|not found|do not have access)/i.test(
      message,
    )
  )
    return "model_limit";
  if (
    code === "transient" ||
    [408, 429].includes(httpStatus ?? 0) ||
    (httpStatus !== undefined && httpStatus >= 500 && httpStatus < 600) ||
    /^(?:rate_limit|overloaded|server_error)$/.test(providerError ?? "") ||
    /\b(?:status|error):?\s*(?:429|5\d\d)\b|overload|stream disconnected before completion|timed? out|connection error|connection refused|network error|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|temporarily limiting requests/i.test(
      message,
    )
  )
    return "temporary";
  return null;
}

/**
 * Why a provider could not run a turn, as the guardian has to act on it:
 * - `temporary`: a rate limit, an overload, the network or a 5xx.
 * - `capacity`: one model is at its own limit or at capacity.
 * - `model_unavailable`: the model is not in the plan, or no longer offered.
 * - `quota`: the subscription's usage limit, which resets.
 * - `spend_cap`: a spending limit the guardian set or a shared budget.
 * - `credits_used_up`: Rome credits or ChatGPT credits are spent.
 * - `login`: the login expired or was revoked.
 * - `removed`: no login at all.
 * docs/domains/agents.md#provider-failure
 */
export type ProviderFailureReason =
  | "temporary"
  | "capacity"
  | "model_unavailable"
  | "quota"
  | "spend_cap"
  | "credits_used_up"
  | "login"
  | "removed";

const ON_ACCOUNT = { state: "available", account: { loggedIn: true } } as const;

/**
 * The reason a failed turn's provider could not run it, or null for a failure
 * that is not the provider's (a prompt too long, a stop, a refusal). Codex on
 * Rome credits fails as the credits do, not as the ChatGPT account it has none of.
 */
export function providerFailureReason(
  failure: AgentTurnFailure | undefined,
  state: ModelAccountReports,
): ProviderFailureReason | null {
  if (!failure || (failure.provider !== "openai" && failure.provider !== "anthropic")) return null;
  const report = state[failure.provider];
  const onCredits = failure.provider === "openai" && !providerAuthorized(report);
  const reason = failoverReason(
    failure,
    onCredits || report?.account.usageLimited === false
      ? { ...state, [failure.provider]: ON_ACCOUNT }
      : state,
  );
  const { message, code, providerError } = failure;
  switch (reason) {
    case "temporary":
      return "temporary";
    case "model_limit":
      return failure.reason === "model_access_denied" ||
        providerError === "model_not_found" ||
        /model.*(?:does not exist|not found|do not have access|not (?:available|supported) (?:on|in|with) your)/i.test(
          message,
        )
        ? "model_unavailable"
        : "capacity";
    case "quota":
      if (code === "credits_used_up" || onCredits || /out of usage credits/i.test(message))
        return "credits_used_up";
      if (
        providerError === "billing_error" ||
        /(?:monthly )?spend(?:ing)? limit|team['’]s shared budget/i.test(message)
      )
        return "spend_cap";
      return "quota";
    case "login":
      if (onCredits && code !== "auth_revoked") return "removed";
      return failure.reason === "not_logged_in" || report?.state === "unauthorized"
        ? "removed"
        : "login";
    default:
      return null;
  }
}
