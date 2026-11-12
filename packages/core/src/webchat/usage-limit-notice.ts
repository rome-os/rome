import type { ModelAccounts, ProviderId } from "../agent/index.js";

/**
 * Tells the Concierge when a provider's usage limit ends: each settled read
 * that shows a provider available after a state that was not. A provider's
 * first read of the process is no change, so a restart alone says nothing here.
 * Call once after startup. Returns what stops it.
 */
export function startUsageLimitNotice(options: {
  accounts: Pick<ModelAccounts, "read" | "onChanged">;
  notify: (headline: string) => Promise<void>;
}): () => void {
  const { accounts, notify } = options;
  const was = new Map<string, string | undefined>(
    Object.entries(accounts.read()).map(([provider, report]) => [provider, report?.state]),
  );
  return accounts.onChanged((provider: ProviderId, change, succeeded) => {
    if (change !== "refreshed" || succeeded === false) return;
    const state = accounts.read()[provider]?.state;
    const before = was.get(provider);
    was.set(provider, state);
    if (state === "available" && before !== undefined && before !== "available")
      void notify(`model usage on ${provider} is available again`);
  });
}
