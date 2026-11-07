// Model account fixtures for tests: a report per provider and a fake
// `ModelAccounts` that reads it.

import type {
  ModelAccountStatus,
  ModelAccounts,
  ModelAccountReports,
  ModelAccountReport,
  ProviderAvailabilityState,
} from "../../agent/index.js";

export function reportOf(
  state: ProviderAvailabilityState,
  account: Partial<ModelAccountStatus> = {},
  usageLimitUntil?: string,
): ModelAccountReport {
  const authorized = state !== "unauthorized" && state !== "expired";
  return {
    state,
    ...(state === "usage_limit_reached"
      ? { usageLimitUntil: usageLimitUntil ?? new Date(Date.now() + 3_600_000).toISOString() }
      : {}),
    account: {
      loggedIn: authorized,
      ...(state === "expired" ? { needsReauth: true } : {}),
      ...account,
    },
  };
}

/** Both providers available on a full plan. */
export function bothAvailable(): ModelAccountReports {
  return { openai: reportOf("available"), anthropic: reportOf("available") };
}

/** A `ModelAccounts` that reads a fixed or computed state and refreshes nothing. */
export function fakeAccounts(
  state: ModelAccountReports | (() => ModelAccountReports),
): Pick<ModelAccounts, "read" | "refresh"> {
  const read = typeof state === "function" ? state : () => state;
  return { read, refresh: async () => {} };
}

/** A ChatGPT plan that serves Terra alone. */
/** A ChatGPT plan that withholds the frontier models, so a tier resolves to Terra. */
export const RESTRICTED_PLAN = {
  modelsDenied: [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-6-luna",
    "gpt-5.6-luna",
  ],
} as const;
