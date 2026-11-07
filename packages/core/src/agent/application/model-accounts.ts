// Model accounts: remembers, for each provider, what its account last
// reported, so the resolver, the concierge and the dashboard can read it
// without waiting on the provider's process. It reads the accounts at start,
// hourly, when an account says it changed and when asked, and tells its
// listeners after each read. The accounts decide what they report
// (domain/model-account.ts); this module decides only when to ask.

import type { AgentLog } from "../domain/agent-log.js";
import type { ModelAccount } from "../domain/model-account.js";
import type { ProviderId } from "../domain/model-port.js";
import {
  currentReport,
  type ModelAccountReports,
  type ModelAccountReport,
  providerAuthorized,
} from "../domain/model-account-report.js";

/**
 * "authorization" when a provider's authorized state changed, "refreshed"
 * when a read of it settled, whether or not the read succeeded.
 */
export type ModelAccountChange = "authorization" | "refreshed";

export interface ModelAccounts {
  /** Pure. A usage limit whose end has passed reads as available. */
  read(): ModelAccountReports;
  /** Reads every account, or one. Resolves when the reads settle, failed or not. */
  refresh(provider?: ProviderId): Promise<void>;
  onChanged(listener: (provider: ProviderId, change: ModelAccountChange) => void): () => void;
  close(): void;
}

export interface CreateModelAccountsOptions {
  accounts: Partial<Record<ProviderId, ModelAccount>>;
  /** Null disables the hourly refresh. */
  refreshIntervalMs?: number | null;
  /** Read every account at creation. Default true. */
  startRefresh?: boolean;
  log?: AgentLog;
  now?: () => Date;
}

const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function createModelAccounts(options: CreateModelAccountsOptions): ModelAccounts {
  const now = options.now ?? (() => new Date());
  const log = options.log;
  const accounts = Object.entries(options.accounts).filter(
    (entry): entry is [ProviderId, ModelAccount] => entry[1] !== undefined,
  );
  const remembered: ModelAccountReports = {};
  const listeners = new Set<(provider: ProviderId, change: ModelAccountChange) => void>();
  // One read per provider at a time. A refresh asked during one joins it.
  const inFlight = new Map<ProviderId, Promise<void>>();
  // Providers whose account changed during a read: read again when it settles.
  const rereadAfter = new Set<ProviderId>();
  let closed = false;

  const emit = (provider: ProviderId, change: ModelAccountChange): void => {
    for (const listener of listeners) {
      try {
        listener(provider, change);
      } catch (err) {
        log?.warn("model accounts listener failed", {
          provider,
          change,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const remember = (provider: ProviderId, next: ModelAccountReport): void => {
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
      const next = await account.report();
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
      const state: ModelAccountReports = {};
      for (const [provider, report] of Object.entries(remembered) as Array<
        [ProviderId, ModelAccountReport]
      >) {
        state[provider] = currentReport(report, at);
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
