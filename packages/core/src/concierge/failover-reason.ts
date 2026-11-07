import type { AgentTurnFailure } from "@rome-os/app-runtime";
import type { QuotaSwitchPart } from "@rome/api-types/chat";
import { providerAuthorized, type ModelAccountReports } from "../agent/index.js";

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
  // Rome credits pay for Codex while its login is out, and recovery must not spend them.
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
