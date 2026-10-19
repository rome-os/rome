import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";
import {
  getClaudeStatus,
  readClaudeUsage,
  type AIToolStatusProbeResult,
} from "../lib/ai-tool-probes.js";
import type { CodexPlanType } from "../lib/codex-cli-auth.js";
import {
  getErrorMessage,
  type AIToolUsageStatus,
  type UsageWindowStatus,
} from "../lib/provider-usage.js";

const log = createLogger("ai-tool-state");
const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
// Exhaustion with no known reset ends after one 5-hour usage window unless a
// probe or failure confirms it again. Waiting only for a successful usage probe
// can wait forever: the Claude CLI renews its token only on a Claude turn, and
// the resolver sends none to an exhausted provider.
const QUOTA_FALLBACK_MS = 5 * 60 * 60 * 1000;

export type AIToolProviderId = "openai" | "anthropic";

export interface ProviderState
  extends Omit<AIToolStatusProbeResult, "loggedIn" | "authMode" | "planType"> {
  /** Undefined means not checked yet and is treated optimistically. */
  loggedIn?: boolean;
  quotaExhausted: boolean;
  /**
   * When exhaustion ends: the latest reset among the exhausted usage windows,
   * or 5 hours after the probe when one of them has no known reset. A runtime
   * quota failure before that time keeps it, and one with nothing ahead ends 5
   * hours after the failure.
   */
  quotaExhaustedUntil?: string;
  usage?: AIToolUsageStatus;
}

export interface AIToolStateValue {
  codex: ProviderState & {
    solAccess: boolean;
    lunaAccess: boolean;
  };
  claude: ProviderState;
}

export interface AIToolState {
  /** Reports quotaExhausted as false once its quotaExhaustedUntil has passed. */
  get(): AIToolStateValue;
  refresh(provider?: AIToolProviderId): Promise<AIToolStateValue>;
  markAuthRevoked(provider: AIToolProviderId): Promise<void>;
  markQuotaExhausted(provider: AIToolProviderId): void;
  close(): void;
}

export interface AIToolStateProbes {
  codexStatus: () => Promise<AIToolStatusProbeResult>;
  claudeStatus: () => Promise<AIToolStatusProbeResult>;
  codexUsage: () => Promise<AIToolUsageStatus | null>;
  claudeUsage: () => Promise<AIToolUsageStatus | null>;
}

export interface CreateAIToolStateOptions {
  settingsRepo?: Pick<SettingsRepository, "get">;
  /** Codex probes must be supplied by the shared app-server account service. */
  probes: Pick<AIToolStateProbes, "codexStatus" | "codexUsage"> &
    Partial<Pick<AIToolStateProbes, "claudeStatus" | "claudeUsage">>;
  /** Null disables the hourly timer (used by deterministic unit tests). */
  refreshIntervalMs?: number | null;
  startRefresh?: boolean;
  /** Called when a Codex login is connected or disconnected. */
  onCodexLoginChanged?: () => void;
  /** Called after each Codex refresh settles, whether or not its probes succeeded. */
  onCodexRefreshed?: () => void;
}

function windowExhausted(window: UsageWindowStatus | undefined): window is UsageWindowStatus {
  return (
    window?.remainingPercent === 0 ||
    (typeof window?.usedPercent === "number" && window.usedPercent >= 100)
  );
}

function latestReset(windows: UsageWindowStatus[]): string | undefined {
  let latest: number | undefined;
  for (const window of windows) {
    const resetMs = Date.parse(window.resetsAt ?? "");
    if (Number.isNaN(resetMs)) return undefined;
    latest = Math.max(latest ?? resetMs, resetMs);
  }
  return latest === undefined ? undefined : new Date(latest).toISOString();
}

function readProviderState<T extends ProviderState>(target: T, now: number): T {
  const expired =
    target.quotaExhaustedUntil !== undefined && Date.parse(target.quotaExhaustedUntil) <= now;
  return expired ? { ...target, quotaExhausted: false } : { ...target };
}

function applyUsage(
  target: ProviderState,
  result: PromiseSettledResult<AIToolUsageStatus | null>,
): void {
  // Unknown usage is not fresh capacity or proof of exhaustion, so the failure
  // branches keep quotaExhausted until a successful probe but drop old bars.
  if (result.status === "rejected") {
    target.usage = {
      checkedAt: new Date().toISOString(),
      source: "usage probe",
      error: getErrorMessage(result.reason),
    };
    return;
  }
  const usage = result.value;
  if (!usage) {
    // Null means no usable usage source, such as a Claude token held in the
    // macOS Keychain, or a CLI token past its expiresAt that only the next
    // Claude turn renews. There is nothing to show and no failure to report.
    delete target.usage;
    return;
  }
  if (usage.error) {
    target.usage = { checkedAt: usage.checkedAt, source: usage.source, error: usage.error };
    return;
  }
  target.usage = usage;
  const exhausted = [usage.fiveHour, usage.sevenDay].filter(windowExhausted);
  target.quotaExhausted = exhausted.length > 0;
  target.quotaExhaustedUntil =
    latestReset(exhausted) ??
    (exhausted.length > 0 ? new Date(Date.now() + QUOTA_FALLBACK_MS).toISOString() : undefined);
}

const CODEX_FULL_MODEL_ACCESS_PLANS = new Set<CodexPlanType>([
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
]);

function deriveCodexModelAccess(status: AIToolStatusProbeResult): {
  solAccess: boolean;
  lunaAccess: boolean;
} {
  if (!status.loggedIn) return { solAccess: false, lunaAccess: false };
  if (status.authMode === "apikey") return { solAccess: true, lunaAccess: true };

  const fullAccess =
    status.planType !== undefined && CODEX_FULL_MODEL_ACCESS_PLANS.has(status.planType);
  return { solAccess: fullAccess, lunaAccess: fullAccess };
}

function applyStatus(target: ProviderState, status: AIToolStatusProbeResult): void {
  target.loggedIn = status.loggedIn;
  target.email = status.email;
  target.authMethod = status.authMethod;
  target.accountType = status.accountType;
  target.needsReauth = status.needsReauth;
  target.anthropicCompatible = status.anthropicCompatible;
}

/** Claude API-key-backed providers do not participate in subscription usage limits. */
export function claudeUsesApiKey(state: ProviderState): boolean {
  return state.authMethod === "stored-compatible" || state.authMethod === "environment";
}

export function createAIToolState(options: CreateAIToolStateOptions): AIToolState {
  const probes: AIToolStateProbes = {
    claudeStatus: () => getClaudeStatus(options.settingsRepo),
    claudeUsage: readClaudeUsage,
    ...options.probes,
  };
  const value: AIToolStateValue = {
    codex: { quotaExhausted: false, solAccess: false, lunaAccess: false },
    claude: { quotaExhausted: false },
  };
  const notifyCodexLoginChanged = (previous: boolean | undefined): boolean => {
    if (previous === value.codex.loggedIn) return false;
    options.onCodexLoginChanged?.();
    return true;
  };
  const refreshProvider = async (provider: AIToolProviderId): Promise<void> => {
    if (provider === "anthropic") {
      const [status, usage] = await Promise.allSettled([
        probes.claudeStatus(),
        probes.claudeUsage(),
      ]);
      if (status.status === "fulfilled") applyStatus(value.claude, status.value);
      if (claudeUsesApiKey(value.claude)) {
        // Do not leak a stale Claude OAuth usage cache into API-key auth.
        value.claude.quotaExhausted = false;
        delete value.claude.quotaExhaustedUntil;
        delete value.claude.usage;
      } else {
        applyUsage(value.claude, usage);
      }
      return;
    }

    // Login drives the Codex payer, so apply it as soon as the status probe
    // settles rather than waiting on a possibly stalled quota probe.
    const statusProbe = Promise.allSettled([probes.codexStatus()]);
    let usageProbe = Promise.allSettled([probes.codexUsage()]);
    const [status] = await statusProbe;
    if (status.status === "fulfilled") {
      const previousCodexLogin = value.codex.loggedIn;
      applyStatus(value.codex, status.value);
      Object.assign(value.codex, deriveCodexModelAccess(status.value));
      // A login change can restart Codex under the usage probe above, so ask
      // the process that serves the new login. The first observation at boot
      // has no earlier probe result to replace.
      if (notifyCodexLoginChanged(previousCodexLogin) && previousCodexLogin !== undefined) {
        usageProbe = Promise.allSettled([probes.codexUsage()]);
      }
    }
    const [usage] = await usageProbe;
    applyUsage(value.codex, usage);
    options.onCodexRefreshed?.();
  };

  // Deduplicate refreshes per provider. A single global lock would incorrectly
  // drop an OpenAI refresh requested while only Anthropic was in flight; a
  // provider-scoped promise lets full refreshes and targeted refreshes share
  // exactly the work they overlap on.
  const refreshesInFlight = new Map<AIToolProviderId, Promise<void>>();
  const refreshProviderLocked = (provider: AIToolProviderId): Promise<void> => {
    const existing = refreshesInFlight.get(provider);
    if (existing) return existing;

    const pending = refreshProvider(provider).finally(() => {
      if (refreshesInFlight.get(provider) === pending) {
        refreshesInFlight.delete(provider);
      }
    });
    refreshesInFlight.set(provider, pending);
    return pending;
  };

  const state: AIToolState = {
    get() {
      // Reading the expiry here needs no timer to clear the flag, and a reset
      // never waits on a usage probe that the endpoint may throttle.
      const now = Date.now();
      return {
        codex: readProviderState(value.codex, now),
        claude: readProviderState(value.claude, now),
      };
    },
    async refresh(provider) {
      if (provider) {
        await refreshProviderLocked(provider);
      } else {
        await Promise.all([refreshProviderLocked("openai"), refreshProviderLocked("anthropic")]);
      }
      return state.get();
    },
    async markAuthRevoked(provider) {
      // A status probe that started before the provider rejected its credential
      // may still hold the old "logged in" answer. Let that work drain first,
      // then make the runtime failure the newest authoritative observation.
      await refreshesInFlight.get(provider);
      const previousCodexLogin = value.codex.loggedIn;
      const target = provider === "openai" ? value.codex : value.claude;
      target.loggedIn = false;
      target.needsReauth = true;
      if (provider === "openai") {
        value.codex.solAccess = false;
        value.codex.lunaAccess = false;
      }
      notifyCodexLoginChanged(previousCodexLogin);
    },
    markQuotaExhausted(provider) {
      // A failure before the usage reset agrees with the snapshot, so the
      // reset still ends it. A failure after the reset comes from a limit the
      // snapshot did not show, so it holds until a successful usage probe or
      // the fallback expiry, whichever comes first.
      // The replay below judges the failure by failedAt. When the older probe
      // showed capacity, the replay restores the reset known at the failure.
      const failedAt = Date.now();
      const resetAhead = (target: ProviderState): string | undefined => {
        const until = target.quotaExhaustedUntil;
        return until !== undefined && Date.parse(until) > failedAt ? until : undefined;
      };
      const resetAtFailure = resetAhead(provider === "openai" ? value.codex : value.claude);
      const fallbackUntil = new Date(failedAt + QUOTA_FALLBACK_MS).toISOString();
      const applyRuntimeSignal = (): boolean => {
        const target = provider === "openai" ? value.codex : value.claude;
        if (provider === "anthropic" && claudeUsesApiKey(target)) return false;
        target.quotaExhaustedUntil =
          (target.quotaExhausted ? resetAhead(target) : resetAtFailure) ?? fallbackUntil;
        target.quotaExhausted = true;
        return true;
      };
      if (!applyRuntimeSignal()) return;

      // Keep this newer runtime signal after any older probe settles.
      const olderRefresh = refreshesInFlight.get(provider);
      if (olderRefresh) void olderRefresh.then(applyRuntimeSignal, applyRuntimeSignal);
    },
    close() {
      if (timer) clearInterval(timer);
    },
  };

  const interval = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const timer =
    interval === null
      ? null
      : (setInterval(() => {
          void state.refresh().catch((err) => {
            log.warn("hourly AI tool state refresh failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, interval).unref?.() ?? null);

  if (options.startRefresh !== false) {
    void state.refresh().catch((err) => {
      log.warn("initial AI tool state refresh failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return state;
}
