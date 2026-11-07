// Model provider availability: whether a run can use a provider now, and why
// not. The provider's account reports it (model-account.ts); the application
// layer remembers the answer and reads it again. This module holds the words
// and the few rules a reader of the remembered answer needs. The time is an
// argument. docs/domains/agents.md carries the language.

import { matchesModelAlias } from "./model-alias.js";
import type { ModelAccountStatus, ModelAccountUsage } from "./model-account.js";
import type { ProviderId } from "./model-port.js";

/** Expired and unauthorized outrank a usage limit: the limit is moot without a credential. */
export type ProviderAvailabilityState =
  | "available"
  | "unauthorized"
  | "expired"
  | "usage_limit_reached";

export interface ProviderAvailability {
  state: ProviderAvailabilityState;
  /** When the usage limit ends, stated or assumed. Set only in usage_limit_reached. */
  usageLimitUntil?: string;
  /** The account's reports the availability was read off, kept as read. */
  account: ModelAccountStatus;
  usage?: ModelAccountUsage;
}

/** The providers that run under an account. The mock has none. */
export type AccountedProviderId = Exclude<ProviderId, "mock">;

/**
 * A provider is absent until its account was read once, or when it has no
 * account (mock). A run treats an absent provider as available.
 */
export type ModelAvailabilityState = Partial<Record<ProviderId, ProviderAvailability>>;

/** The remembered availability as of `now`: a usage limit whose end has passed reads as available. */
export function currentAvailability(
  remembered: ProviderAvailability,
  now: Date,
): ProviderAvailability {
  if (remembered.state !== "usage_limit_reached") return remembered;
  if (Date.parse(remembered.usageLimitUntil ?? "") > now.getTime()) return remembered;
  const { usageLimitUntil: _ended, ...rest } = remembered;
  return { ...rest, state: "available" };
}

/** A run can use the provider: it is available, or Rome has not read it yet. */
export function providerUsable(availability: ProviderAvailability | undefined): boolean {
  return availability === undefined || availability.state === "available";
}

/** The account is authorized, or Rome has not read it yet. */
export function providerAuthorized(availability: ProviderAvailability | undefined): boolean {
  return (
    availability === undefined ||
    (availability.state !== "unauthorized" && availability.state !== "expired")
  );
}

/** Whether the account's plan allows the model: one its plan does not withhold. */
export function accountAllowsModel(account: ModelAccountStatus, model: string): boolean {
  return !account.modelsDenied?.some((denied) => matchesModelAlias(model, denied));
}
