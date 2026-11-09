import type { MainBackendTurnRunner } from "../apps/actions/backend-turn.js";
import {
  isAnthropicUsageLimitError,
  type ModelAccountReports,
  type ModelAccounts,
  type ProviderId,
} from "../agent/index.js";
import { failoverReason } from "../concierge/failover-reason.js";
import { createLogger } from "../logger.js";
import type { ChatsWebChatRepository, ErroredTurn } from "./chats-webchat-repository.js";
import { isRecentActivity, MAX_RESTART_INACTIVITY_MS } from "./restart-continuation.js";

const log = createLogger("usage-limit-continuation");
const USAGE_LIMIT_MARKER = "<usage_limit_recovery>";
/** The longest delay setTimeout accepts. A later limit end is reached in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** `request` is empty when no excerpt is known. `refused` marks a request that never reached a model. */
export function usageLimitContinuationPrompt(request: string, refused: boolean): string {
  return (
    USAGE_LIMIT_MARKER +
    "The previous turn in this chat stopped because a model usage limit was reached, and the limit has since reset. " +
    (refused
      ? "That request was refused before it reached a model, so none of it was done. Treat it as the request to act on. "
      : "") +
    "Read this chat's history to see what was running. " +
    "Check the actual state of the work and verify anything uncertain. Do only what remains. " +
    "If a side-effecting action cannot be confirmed, ask the guardian rather than redo it. " +
    "The request below is cut at 1000 characters, so read the chat for its full text. " +
    "</usage_limit_recovery>" +
    (request
      ? `\n\n${refused ? "Refused request" : "Stopped request (may already be partly complete)"}:\n${request}`
      : "")
  );
}

/**
 * The provider whose usage limit stopped this turn, or null when something else did.
 * A mid-run error block does not name its provider, so the chat's model pin does.
 * Spend limits, credit balances and sign-in problems are not usage limits.
 */
function usageLimitProviderOf(
  { failure, pinnedProvider }: ErroredTurn,
  reports: ModelAccountReports,
): ProviderId | null {
  const provider = failure.provider ?? pinnedProvider;
  if (provider !== "openai" && provider !== "anthropic") return null;
  if (failoverReason({ ...failure, provider }, reports) !== "quota") return null;
  const stated =
    failure.code === "usage_limit" ||
    failure.reason === "quota_exhausted" ||
    isAnthropicUsageLimitError(failure.message);
  return stated ? provider : null;
}

export interface UsageLimitContinuationOptions {
  accounts: Pick<ModelAccounts, "read" | "refresh" | "onChanged">;
  repo: Pick<
    ChatsWebChatRepository,
    | "getLatestErroredTurns"
    | "canContinueAfterRestart"
    | "getRestartGuardianPrompt"
    | "getRestartLastActivityAt"
  >;
  runner: Pick<MainBackendTurnRunner, "runAndReport">;
}

/**
 * Continues guardian turns a usage limit stopped, once the limit has cleared.
 * Call once after startup. A provider's account is read again when its limit
 * ends, and each settled read that shows it available sweeps its stopped
 * turns, one chat at a time. A turn that began less than a day ago, in a
 * top-level dashboard chat nobody has written in since, gets one continuation.
 * Returns what stops it.
 */
export function startUsageLimitContinuation(options: UsageLimitContinuationOptions): () => void {
  const { accounts, repo, runner } = options;
  const timers = new Map<ProviderId, { until: number; timer: NodeJS.Timeout }>();
  // Stopped turns already handed over, so repeated reads never continue one twice.
  const attempted = new Set<string>();
  const pending = new Set<ProviderId>();
  let sweeping = false;
  let stopped = false;

  const available = (provider: ProviderId) => accounts.read()[provider]?.state === "available";

  const sweep = async (provider: ProviderId): Promise<void> => {
    if (!available(provider)) return;
    for (const stop of repo.getLatestErroredTurns(Date.now() - MAX_RESTART_INACTIVITY_MS)) {
      if (stopped) return;
      const { turn } = stop;
      // The marker lives in turn_start's prompt, so a recovery can never be recovered again.
      if (attempted.has(turn.messageId) || !turn.runtimeSessionId) continue;
      if (turn.prompt.includes(USAGE_LIMIT_MARKER)) continue;
      if (usageLimitProviderOf(stop, accounts.read()) !== provider) continue;
      try {
        if (!repo.canContinueAfterRestart(turn)) continue;
        if (!isRecentActivity(repo.getRestartLastActivityAt(turn), Date.now())) continue;
        // A continuation against a provider that is limited again would fail at once.
        if (!available(provider)) return;
        attempted.add(turn.messageId);
        let dropped = false;
        await runner.runAndReport(
          {
            agentName: turn.agentName,
            sessionId: turn.runtimeSessionId,
            channel: "webchat",
            threadId: turn.sessionId,
            prompt: usageLimitContinuationPrompt(
              repo.getRestartGuardianPrompt(turn),
              stop.failure.code === "model_provider_unavailable" ||
                stop.failure.code === "no_model_provider_available",
            ),
          },
          {
            inputLabel: "Usage limit recovery",
            shouldRun: () => {
              const run = !stopped && available(provider) && repo.canContinueAfterRestart(turn);
              if (!run) dropped = true;
              return run;
            },
          },
        );
        // A turn that never ran is still stopped, and the next reset may continue it.
        if (dropped) attempted.delete(turn.messageId);
      } catch (error) {
        log.warn("could not continue usage-limit turn", {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          error: String(error),
        });
      }
    }
  };

  // One sweep at a time. A request that arrives during one runs after it.
  const drain = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const provider of pending) {
        pending.delete(provider);
        if (stopped) break;
        await sweep(provider).catch((error) =>
          log.warn("usage-limit sweep failed", { provider, error: String(error) }),
        );
      }
    } finally {
      sweeping = false;
    }
  };

  // Nothing else fires when a limit's end passes, so one read is timed for it.
  const arm = (provider: ProviderId): void => {
    const report = accounts.read()[provider];
    const until =
      report?.state === "usage_limit_reached" ? Date.parse(report.usageLimitUntil ?? "") : NaN;
    const current = timers.get(provider);
    if (current?.until === until) return;
    if (current) clearTimeout(current.timer);
    timers.delete(provider);
    if (!Number.isFinite(until)) return;
    const timer = setTimeout(
      () => {
        timers.delete(provider);
        void accounts.refresh(provider).catch((error) =>
          log.warn("model account read at usage-limit reset failed", {
            provider,
            error: String(error),
          }),
        );
      },
      Math.min(Math.max(until - Date.now(), 0), MAX_TIMER_MS),
    );
    timer.unref?.();
    timers.set(provider, { until, timer });
  };

  const onRead = (provider: ProviderId, change: "authorization" | "refreshed"): void => {
    if (stopped) return;
    arm(provider);
    if (change === "refreshed" && available(provider)) {
      pending.add(provider);
      void drain();
    }
  };

  // Reads that settled before this started, such as a limit that ended while Rome was down.
  for (const provider of Object.keys(accounts.read()) as ProviderId[])
    onRead(provider, "refreshed");
  const unsubscribe = accounts.onChanged(onRead);

  return () => {
    stopped = true;
    unsubscribe();
    for (const { timer } of timers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
  };
}
