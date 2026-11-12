import {
  isAnthropicUsageLimitError,
  type ModelAccountReports,
  type ModelAccounts,
  type ProviderId,
} from "../agent/index.js";
import { failoverReason } from "../agent/index.js";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import type { ChatsWebChatRepository, ErroredTurn } from "./chats-webchat-repository.js";
import {
  describeInterrupted,
  interruptedNoticeText,
  MAX_RESTART_INACTIVITY_MS,
} from "./interrupted-notice.js";

const log = createLogger("usage-limit-continuation");

/**
 * The provider whose usage limit stopped this turn, or null when something else did.
 * A mid-run error block does not name its provider, so the chat's model pin does.
 * An error that names another provider than the pin is left stopped.
 * Spend limits, credit balances and sign-in problems are not usage limits.
 */
export function usageLimitProviderOf(
  { failure, pinnedProvider }: ErroredTurn,
  reports: ModelAccountReports,
): ProviderId | null {
  // A resumed session runs on its pin, so a refusal on another provider would not be retried there.
  if (failure.provider && pinnedProvider && failure.provider !== pinnedProvider) return null;
  const provider = failure.provider ?? pinnedProvider;
  if (provider !== "openai" && provider !== "anthropic") return null;
  if (failoverReason({ ...failure, provider }, reports) !== "quota") return null;
  const stated =
    failure.code === "usage_limit" ||
    failure.reason === "quota_exhausted" ||
    isAnthropicUsageLimitError(failure.message);
  return stated ? provider : null;
}

export interface UsageLimitNoticeOptions {
  accounts: Pick<ModelAccounts, "read" | "onChanged">;
  db: DrizzleDb;
  repo: Pick<ChatsWebChatRepository, "getLatestErroredTurns" | "getRestartLastActivityAt">;
  /** Tells the Concierge: one message per provider that became available. */
  notify: (text: string) => Promise<void>;
}

/**
 * Tells the Concierge which guardian chats a usage limit stopped, once the
 * limit has cleared. Call once after startup. Each settled read of an account
 * that shows its provider available lists that provider's stopped turns with
 * activity in the last day, in one notice. A stopped turn is listed once per
 * process. Returns what stops it.
 */
export function startUsageLimitNotice(options: UsageLimitNoticeOptions): () => void {
  const { accounts, db, repo, notify } = options;
  const attempted = new Set<string>();
  let stopped = false;

  const announce = (provider: ProviderId): void => {
    if (accounts.read()[provider]?.state !== "available") return;
    const now = Date.now();
    const turns = repo
      .getLatestErroredTurns(now - MAX_RESTART_INACTIVITY_MS)
      .filter((stop) => !attempted.has(stop.turn.messageId))
      .filter((stop) => usageLimitProviderOf(stop, accounts.read()) === provider);
    const refused = new Set(
      turns
        .filter(
          ({ failure: { code } }) =>
            code === "model_provider_unavailable" || code === "no_model_provider_available",
        )
        .map(({ turn }) => turn.sessionId),
    );
    const items = describeInterrupted(
      db,
      repo,
      turns.map(({ turn }) => turn),
      now,
      "usage_limit",
    ).map((item) => ({ ...item, nothingDone: refused.has(item.sessionId) }));
    for (const { turn } of turns) attempted.add(turn.messageId);
    if (items.length === 0) return;
    const headline = `Model usage on ${provider} is available again; these chats stopped on its limit:`;
    void notify(interruptedNoticeText(items, headline)).catch((error) =>
      log.warn("could not tell the Concierge a usage limit cleared", {
        provider,
        error: String(error),
      }),
    );
  };

  // A read that failed shows nothing new. The pass over state remembered before this started has no read to report.
  const onRead = (
    provider: ProviderId,
    change: "authorization" | "refreshed",
    succeeded?: boolean,
  ): void => {
    if (stopped || change !== "refreshed" || succeeded === false) return;
    try {
      announce(provider);
    } catch (error) {
      log.warn("usage-limit notice failed", { provider, error: String(error) });
    }
  };

  // Reads that settled before this started, such as a limit that ended while Rome was down.
  for (const provider of Object.keys(accounts.read()) as ProviderId[])
    onRead(provider, "refreshed");
  const unsubscribe = accounts.onChanged(onRead);

  return () => {
    stopped = true;
    unsubscribe();
  };
}
