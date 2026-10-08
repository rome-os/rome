import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";
import {
  getClaudeStatus,
  readClaudeUsage,
  type AIToolStatusProbeResult,
} from "../lib/ai-tool-probes.js";
import type { CodexPlanType } from "../lib/codex-cli-auth.js";
import type { AIToolUsageStatus } from "../lib/provider-usage.js";

const log = createLogger("ai-tool-state");
const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export type AIToolProviderId = "openai" | "anthropic";

export interface ProviderState
  extends Omit<AIToolStatusProbeResult, "loggedIn" | "authMode" | "planType"> {
  /** Undefined means not checked yet and is treated optimistically. */
  loggedIn?: boolean;
  quotaExhausted: boolean;
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
}

function usageShowsExhaustion(usage: AIToolUsageStatus): boolean {
  return [usage.fiveHour, usage.sevenDay].some(
    (window) =>
      window?.remainingPercent === 0 ||
      (typeof window?.usedPercent === "number" && window.usedPercent >= 100),
  );
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
        delete value.claude.usage;
      } else if (usage.status === "fulfilled" && usage.value && !usage.value.error) {
        value.claude.usage = usage.value;
        value.claude.quotaExhausted = usageShowsExhaustion(usage.value);
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
    if (usage.status === "fulfilled" && usage.value && !usage.value.error) {
      value.codex.usage = usage.value;
      value.codex.quotaExhausted = usageShowsExhaustion(usage.value);
    }
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
      return { codex: { ...value.codex }, claude: { ...value.claude } };
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
      const applyRuntimeSignal = (): boolean => {
        const target = provider === "openai" ? value.codex : value.claude;
        if (provider === "anthropic" && claudeUsesApiKey(target)) return false;
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
