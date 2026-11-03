// App lifecycle failure codes and the HTTP status each one answers with.
//
// The status is part of the contract, not an implementation detail of the
// route: a client branches on 400 vs 404 vs 409 to tell "you may not do that"
// from "it isn't there" from "something else is mid-flight". Keeping the
// mapping here means the route and any client predicting it — the dashboard's
// mock backend today — read one table instead of two hand-written switches
// that can disagree by a digit.

export const APP_MANAGER_ERROR_CODES = [
  "INVALID_APP_ID",
  "NOT_INSTALLED",
  "SYSTEM_PROTECTED",
  "FIRST_PARTY_PROTECTED",
  "ALREADY_IN_FLIGHT",
  "ARTIFACT_INVALID",
] as const;

export type AppManagerErrorCode = (typeof APP_MANAGER_ERROR_CODES)[number];

/**
 * 400 covers every "this request is not allowed" code — a malformed id, and the
 * two protected-app refusals. 409 is reserved for a lifecycle operation already
 * in flight, so a caller can retry that one and only that one; 422 marks an
 * artifact that parsed but failed validation.
 */
export const APP_MANAGER_ERROR_STATUS = {
  INVALID_APP_ID: 400,
  SYSTEM_PROTECTED: 400,
  FIRST_PARTY_PROTECTED: 400,
  NOT_INSTALLED: 404,
  ALREADY_IN_FLIGHT: 409,
  ARTIFACT_INVALID: 422,
} as const satisfies Record<AppManagerErrorCode, number>;
