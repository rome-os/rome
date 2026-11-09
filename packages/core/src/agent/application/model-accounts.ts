// Model accounts: remembers, for each provider, what its account last
// reported, so its readers can read it without waiting on the provider's
// process. It reads the accounts at start, hourly, when an account says it
// changed, shortly after a stated usage limit ends and when asked, and tells
// its listeners after each read. The accounts decide what they report
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
 * when a read of it settled, whether or not the read succeeded. A "refreshed"
 * listener also gets whether it did.
 */
export type ModelAccountChange = "authorization" | "refreshed";

export interface ModelAccounts {
  /** Pure. A usage limit whose end has passed reads as available. */
  read(): ModelAccountReports;
  /**
   * Reads every account, or one. Resolves when the reads settle, failed or
   * not: true only when every read succeeded, and a failed one keeps the last answer.
   */
  refresh(provider?: ProviderId): Promise<boolean>;
  onChanged(
    listener: (provider: ProviderId, change: ModelAccountChange, succeeded?: boolean) => void,
  ): () => void;
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
/**
 * How long after a stated limit end the account is read. At the end itself a
 * fresh usage read cannot contradict the stated end, and a provider that
 * resets a little late would still report the limit.
 */
export const RESET_GRACE_MS = 2 * 60 * 1000;
/** The longest delay setTimeout accepts. A later read is reached in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function createModelAccounts(options: CreateModelAccountsOptions): ModelAccounts {
  const now = options.now ?? (() => new Date());
  const log = options.log;
  const accounts = Object.entries(options.accounts).filter(
    (entry): entry is [ProviderId, ModelAccount] => entry[1] !== undefined,
  );
  const remembered: ModelAccountReports = {};
  const listeners = new Set<
    (provider: ProviderId, change: ModelAccountChange, succeeded?: boolean) => void
  >();
  // One read per provider at a time. A refresh asked during one joins it.
  const inFlight = new Map<ProviderId, Promise<boolean>>();
  // Providers whose account changed during a read: read again when it settles.
  const rereadAfter = new Set<ProviderId>();
  // One read per limited provider, timed for the end of its limit.
  const resetTimers = new Map<ProviderId, { until: number; timer: NodeJS.Timeout }>();
  let closed = false;

  const emit = (provider: ProviderId, change: ModelAccountChange, succeeded?: boolean): void => {
    for (const listener of listeners) {
      try {
        listener(provider, change, succeeded);
      } catch (err) {
        log?.warn("model accounts listener failed", {
          provider,
          change,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // (Re)arms the read for a limit's end when the remembered end changes. The
  // timer only fires after the end, so a limit that already ended arms none.
  const armReset = (provider: ProviderId, account: ModelAccount): void => {
    const report = remembered[provider];
    const until =
      report?.state === "usage_limit_reached" ? Date.parse(report.usageLimitUntil ?? "") : NaN;
    const current = resetTimers.get(provider);
    if (current?.until === until) return;
    if (current) clearTimeout(current.timer);
    resetTimers.delete(provider);
    const wait = until + RESET_GRACE_MS - now().getTime();
    if (closed || !Number.isFinite(until) || wait <= 0) return;
    const timer = setTimeout(
      () => {
        resetTimers.delete(provider);
        // A failed read leaves the report as it was, so the remaining wait is armed again.
        void refreshProvider(provider, account).finally(() => armReset(provider, account));
      },
      Math.min(wait, MAX_TIMER_MS),
    );
    timer.unref?.();
    resetTimers.set(provider, { until, timer });
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

  const readAccount = async (provider: ProviderId, account: ModelAccount): Promise<boolean> => {
    try {
      const next = await account.report();
      if (!closed) {
        remember(provider, next);
        armReset(provider, account);
      }
      return true;
    } catch (err) {
      log?.warn("model account read failed", {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const refreshProvider = (provider: ProviderId, account: ModelAccount): Promise<boolean> => {
    const existing = inFlight.get(provider);
    if (existing) return existing;
    const pending = readAccount(provider, account).then((succeeded) => {
      if (inFlight.get(provider) === pending) inFlight.delete(provider);
      if (closed) return succeeded;
      emit(provider, "refreshed", succeeded);
      if (rereadAfter.delete(provider)) void refreshProvider(provider, account);
      return succeeded;
    });
    inFlight.set(provider, pending);
    return pending;
  };

  const refresh = async (provider?: ProviderId): Promise<boolean> => {
    const targets = provider ? accounts.filter(([id]) => id === provider) : accounts;
    const reads = await Promise.all(targets.map(([id, account]) => refreshProvider(id, account)));
    return reads.every(Boolean);
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
      for (const { timer: reset } of resetTimers.values()) clearTimeout(reset);
      resetTimers.clear();
      for (const unsubscribe of unsubscribers) unsubscribe();
      listeners.clear();
    },
  };
}
