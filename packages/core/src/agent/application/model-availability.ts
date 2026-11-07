// Model availability: remembers, for each provider, what its account last
// reported, so the resolver, the concierge and the dashboard can read it
// without waiting on the provider's process. It reads the accounts at start,
// hourly, when an account says it changed and when asked, and tells its
// listeners after each read. The accounts decide what they report
// (domain/model-account.ts); this module decides only when to ask.

import type { ModelAccount } from "../domain/model-account.js";
import type { ProviderId } from "../domain/model-port.js";
import {
  currentAvailability,
  type ModelAvailabilityState,
  type ProviderAvailability,
  providerAuthorized,
} from "../domain/provider-availability.js";

/**
 * "authorization" when a provider's authorized state changed, "refreshed"
 * when a read of it settled, whether or not the read succeeded.
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
  const remembered: ModelAvailabilityState = {};
  const listeners = new Set<(provider: ProviderId, change: ModelAvailabilityChange) => void>();
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

  const remember = (provider: ProviderId, next: ProviderAvailability): void => {
    const previous = remembered[provider];
    remembered[provider] = next;
    if (previous?.state !== next.state) {
      log?.info("model provider availability changed", {
        provider,
        from: previous?.state ?? "unread",
        to: next.state,
        until: next.usageLimitUntil,
      });
    }
    if (providerAuthorized(previous) !== providerAuthorized(next)) emit(provider, "authorization");
  };

  const readAccount = async (provider: ProviderId, account: ModelAccount): Promise<void> => {
    try {
      const next = await account.availability();
      if (!closed) remember(provider, next);
    } catch (err) {
      log?.warn("model account read failed", {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const refreshProvider = (provider: ProviderId, account: ModelAccount): Promise<void> => {
    const existing = inFlight.get(provider);
    if (existing) return existing;
    const pending = readAccount(provider, account).finally(() => {
      if (inFlight.get(provider) === pending) inFlight.delete(provider);
      if (closed) return;
      emit(provider, "refreshed");
      if (rereadAfter.delete(provider)) void refreshProvider(provider, account);
    });
    inFlight.set(provider, pending);
    return pending;
  };

  const refresh = async (provider?: ProviderId): Promise<void> => {
    const targets = provider ? accounts.filter(([id]) => id === provider) : accounts;
    await Promise.all(targets.map(([id, account]) => refreshProvider(id, account)));
  };

  // A read in flight may have asked the account before it changed, so its
  // answer cannot be trusted to carry the change: read once more after it.
  const unsubscribers = accounts.map(([provider, account]) =>
    account.onChanged(() => {
      if (inFlight.has(provider)) rereadAfter.add(provider);
      else void refreshProvider(provider, account);
    }),
  );

  const interval =
    options.refreshIntervalMs === undefined
      ? DEFAULT_REFRESH_INTERVAL_MS
      : options.refreshIntervalMs;
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
      for (const [provider, availability] of Object.entries(remembered) as Array<
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
