// Model availability: knows, for each provider, whether a run can use it now
// and why not, from the account's own reports. It leaves learning from a
// refused turn to the provider's adapter, choosing a provider to the
// resolver, and the dashboard's response shape to the API. The rules are in
// domain/provider-availability.ts; this module holds the state and drives
// the reads.

import type {
  ModelAccount,
  ModelAccountStatus,
  ModelAccountUsage,
} from "../domain/model-account.js";
import type { ProviderId } from "../domain/model-port.js";
import {
  availabilityFromAccount,
  currentAvailability,
  providerAuthorized,
  type ModelAvailabilityState,
  type ProviderAvailability,
} from "../domain/provider-availability.js";

/**
 * "authorization" when a provider's authorized state changed, "refreshed"
 * when a read of it settled, whether or not the reads succeeded.
 */
export type ModelAvailabilityChange = "authorization" | "refreshed";

export interface ModelAvailability {
  /** Pure. A usage limit whose end has passed reads as available. */
  read(): ModelAvailabilityState;
  /** Reads every account, or one. Resolves when the reads settle, failed or not. */
  refresh(provider?: ProviderId): Promise<void>;
  onChanged(listener: (provider: ProviderId, change: ModelAvailabilityChange) => void): () => void;
  close(): void;
}

/** What the application logs. The composition root passes Rome's logger. */
export interface ModelAvailabilityLog {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface CreateModelAvailabilityOptions {
  accounts: Partial<Record<ProviderId, ModelAccount>>;
  /** Null disables the hourly refresh. */
  refreshIntervalMs?: number | null;
  /** Read every account at creation. Default true. */
  startRefresh?: boolean;
  log?: ModelAvailabilityLog;
  now?: () => Date;
}

const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function createModelAvailability(
  options: CreateModelAvailabilityOptions,
): ModelAvailability {
  const now = options.now ?? (() => new Date());
  const log = options.log;
  const accounts = Object.entries(options.accounts).filter(
    (entry): entry is [ProviderId, ModelAccount] => entry[1] !== undefined,
  );
  const stored: ModelAvailabilityState = {};
  const listeners = new Set<(provider: ProviderId, change: ModelAvailabilityChange) => void>();
  // Logged when it changes, not on every read that confirms it.
  const loggedAtLimit = new Map<ProviderId, boolean>();
  // One read per provider at a time. A refresh asked during one joins it.
  const inFlight = new Map<ProviderId, Promise<void>>();
  // Providers whose account changed during a read: read again when it settles.
  const rereadAfter = new Set<ProviderId>();
  let closed = false;

  const emit = (provider: ProviderId, change: ModelAvailabilityChange): void => {
    for (const listener of listeners) {
      try {
        listener(provider, change);
      } catch (err) {
        log?.warn("model availability listener failed", {
          provider,
          change,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const logLimitChange = (provider: ProviderId, source: string): void => {
    const availability = stored[provider];
    if (!availability) return;
    const current = currentAvailability(availability, now());
    const atLimit = current.state === "usage_limit_reached";
    if (atLimit === (loggedAtLimit.get(provider) ?? false)) return;
    loggedAtLimit.set(provider, atLimit);
    if (atLimit) {
      log?.warn("model provider usage limit reached", {
        provider,
        source,
        until: current.usageLimitUntil,
        fiveHourUsedPercent: current.usage?.fiveHour?.usedPercent,
        sevenDayUsedPercent: current.usage?.sevenDay?.usedPercent,
      });
    } else {
      log?.info("model provider usage limit cleared", {
        provider,
        source: availability.state === "usage_limit_reached" ? "end time passed" : source,
      });
    }
  };

  const store = (
    provider: ProviderId,
    status: ModelAccountStatus,
    usage: ModelAccountUsage | null,
  ): void => {
    const previous = stored[provider];
    const next: ProviderAvailability = availabilityFromAccount(status, usage, now(), previous);
    stored[provider] = next;
    if (providerAuthorized(previous) !== providerAuthorized(next)) emit(provider, "authorization");
  };

  /**
   * Reads status and usage together. The status lands as soon as it answers,
   * with the usage last read, so an authorization change never waits on a
   * usage read that may stall. The usage is folded in when it settles.
   */
  const readAccount = async (provider: ProviderId, account: ModelAccount): Promise<void> => {
    const usagePending = account.usage();
    const status = await Promise.allSettled([account.status()]).then(([result]) => result);
    if (closed) return;
    if (status.status === "rejected") {
      log?.warn("model account status read failed", {
        provider,
        error: status.reason instanceof Error ? status.reason.message : String(status.reason),
      });
    }
    const readStatus = status.status === "fulfilled" ? status.value : stored[provider]?.account;
    if (!readStatus) {
      await Promise.allSettled([usagePending]);
      return;
    }
    store(provider, readStatus, stored[provider]?.usage ?? null);
    const [usage] = await Promise.allSettled([usagePending]);
    if (closed) return;
    const readUsage =
      usage.status === "fulfilled"
        ? usage.value
        : {
            checkedAt: now().toISOString(),
            source: "usage read",
            error: usage.reason instanceof Error ? usage.reason.message : String(usage.reason),
          };
    store(provider, readStatus, readUsage);
  };

  const refreshProvider = (provider: ProviderId, account: ModelAccount): Promise<void> => {
    const existing = inFlight.get(provider);
    if (existing) return existing;
    logLimitChange(provider, "end time passed");
    const pending = readAccount(provider, account).finally(() => {
      if (inFlight.get(provider) === pending) inFlight.delete(provider);
      logLimitChange(provider, "usage read");
      if (!closed) emit(provider, "refreshed");
    });
    inFlight.set(provider, pending);
    return pending;
  };

  /**
   * The account says it changed. A read already in flight may have asked the
   * account before the change, so its answer cannot be trusted to carry it:
   * read once more when it settles.
   */
  const readChangedAccount = (provider: ProviderId, account: ModelAccount): void => {
    const existing = inFlight.get(provider);
    if (!existing) {
      void refreshProvider(provider, account);
      return;
    }
    if (rereadAfter.has(provider)) return;
    rereadAfter.add(provider);
    void existing.finally(() => {
      rereadAfter.delete(provider);
      if (!closed) void refreshProvider(provider, account);
    });
  };

  const refresh = async (provider?: ProviderId): Promise<void> => {
    const targets = provider ? accounts.filter(([id]) => id === provider) : accounts;
    await Promise.all(targets.map(([id, account]) => refreshProvider(id, account)));
  };

  const unsubscribers = accounts.map(([provider, account]) =>
    account.onChanged(() => {
      readChangedAccount(provider, account);
    }),
  );

  const interval = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const timer =
    interval === null
      ? null
      : setInterval(() => {
          void refresh();
        }, interval);
  timer?.unref?.();

  if (options.startRefresh !== false) void refresh();

  return {
    read() {
      const at = now();
      const state: ModelAvailabilityState = {};
      for (const [provider, availability] of Object.entries(stored) as Array<
        [ProviderId, ProviderAvailability]
      >) {
        state[provider] = currentAvailability(availability, at);
      }
      return state;
    },
    refresh,
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      listeners.clear();
    },
  };
}
