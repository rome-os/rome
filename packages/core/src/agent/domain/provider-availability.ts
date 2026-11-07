// Model provider availability: whether a run can use a provider now, and why
// not, read off what the provider's account reports about itself. The rules
// are functions over values; the time is an argument. The application layer
// holds the state and drives the reads. docs/domains/agents.md carries the
// language.

import { matchesModelAlias } from "./model-alias.js";
import type { ModelAccountStatus, ModelAccountUsage, ModelUsageWindow } from "./model-account.js";
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
  /** The account's last reports, kept as read. */
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

/**
 * A usage limit with no known end ends this long after it was seen, unless a
 * read or a refusal confirms it again. Waiting for a usage read that shows
 * capacity can wait forever: the Claude CLI renews its token only on a Claude
 * turn, and the resolver sends none to a provider at its limit.
 */
export const USAGE_LIMIT_FALLBACK_MS = 5 * 60 * 60 * 1000;

function windowExhausted(window: ModelUsageWindow | undefined): window is ModelUsageWindow {
  return (
    window?.remainingPercent === 0 ||
    (typeof window?.usedPercent === "number" && window.usedPercent >= 100)
  );
}

/** Usage was read and no window is exhausted: the provider has capacity again. */
export function usageShowsCapacity(usage: ModelAccountUsage): boolean {
  const windows = [usage.fiveHour, usage.sevenDay].filter((w) => w !== undefined);
  return !usage.error && windows.length > 0 && !windows.some(windowExhausted);
}

/** The latest reset among the windows, or undefined when one has none. */
function latestReset(windows: ModelUsageWindow[]): string | undefined {
  let latest: number | undefined;
  for (const window of windows) {
    const resetMs = Date.parse(window.resetsAt ?? "");
    if (Number.isNaN(resetMs)) return undefined;
    latest = Math.max(latest ?? resetMs, resetMs);
  }
  return latest === undefined ? undefined : new Date(latest).toISOString();
}

function ahead(until: string | undefined, now: Date): string | undefined {
  return until !== undefined && Date.parse(until) > now.getTime() ? until : undefined;
}

/**
 * What the account's status and usage amount to, read at `readAt`. The end
 * of a usage limit is the time the account reports for a refused turn, else
 * the latest reset among the exhausted windows, else the fallback after the
 * usage was checked, so reading the same usage again never moves the end. Usage that could not be read
 * (null, or an error) proves neither capacity nor a limit, so a limit still
 * ahead carries over from `previous`.
 */
export function availabilityFromAccount(
  status: ModelAccountStatus,
  usage: ModelAccountUsage | null,
  readAt: Date,
  previous?: ProviderAvailability,
): ProviderAvailability {
  const account = { ...status };
  const base: ProviderAvailability = { state: "available", account };
  if (usage) base.usage = usage;
  if (status.needsReauth) return { ...base, state: "expired" };
  if (!status.loggedIn) return { ...base, state: "unauthorized" };
  if (status.usageLimited === false) return base;

  const limit = (until: string): ProviderAvailability => ({
    ...base,
    state: "usage_limit_reached",
    usageLimitUntil: until,
  });
  // A refusal the account still reports after its end is over, so a refusal
  // never renews itself.
  const refusedUntil = ahead(status.usageLimitUntil, readAt);
  if (!usage || usage.error) {
    const carried = refusedUntil ?? ahead(previous?.usageLimitUntil, readAt);
    return carried ? limit(carried) : base;
  }
  // The exhausted windows say when the limit ends better than a refusal's
  // assumed end does: a weekly window outlasts it, a five-hour window may
  // reset before it. Without a reset time the end is assumed from when the
  // usage was checked, and once that has passed the window is no evidence.
  const exhausted = [usage.fiveHour, usage.sevenDay].filter(windowExhausted);
  if (exhausted.length > 0) {
    const checkedAt = Date.parse(usage.checkedAt);
    const seenAt = Number.isNaN(checkedAt) ? readAt.getTime() : checkedAt;
    const fallback = new Date(seenAt + USAGE_LIMIT_FALLBACK_MS).toISOString();
    const windowEnd = ahead(latestReset(exhausted) ?? fallback, readAt);
    if (windowEnd) return limit(windowEnd);
  }
  return refusedUntil ? limit(refusedUntil) : base;
}

/** The stored availability as of `now`: a usage limit whose end has passed reads as available. */
export function currentAvailability(stored: ProviderAvailability, now: Date): ProviderAvailability {
  if (stored.state !== "usage_limit_reached") return stored;
  if (ahead(stored.usageLimitUntil, now)) return stored;
  const { usageLimitUntil: _ended, ...rest } = stored;
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
