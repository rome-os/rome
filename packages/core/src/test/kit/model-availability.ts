// Model availability fixtures for tests: a state per provider and a fake
// `ModelAvailability` that reads it.

import type {
  ModelAccountStatus,
  ModelAvailability,
  ModelAvailabilityState,
  ProviderAvailability,
  ProviderAvailabilityState,
} from "../../agent/index.js";

export function availabilityOf(
  state: ProviderAvailabilityState,
  account: Partial<ModelAccountStatus> = {},
  usageLimitUntil?: string,
): ProviderAvailability {
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
export function bothAvailable(): ModelAvailabilityState {
  return { openai: availabilityOf("available"), anthropic: availabilityOf("available") };
}

/** A `ModelAvailability` that reads a fixed or computed state and refreshes nothing. */
export function fakeAvailability(
  state: ModelAvailabilityState | (() => ModelAvailabilityState),
): Pick<ModelAvailability, "read" | "refresh"> {
  const read = typeof state === "function" ? state : () => state;
  return { read, refresh: async () => {} };
}

/** A ChatGPT plan that serves Terra alone. */
export const TERRA_ONLY_PLAN = { models: ["gpt-5.6-terra"] } as const;
