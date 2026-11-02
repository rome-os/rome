import { claudeUsesApiKey, type AIToolProviderId, type AIToolStateValue } from "./ai-tool-state.js";
import type { ModelTier } from "./agent-runner.js";
import type { ModelSelectionId } from "./model-selector.js";

/**
 * The model a click would move a chat to when `from` is out of subscription
 * quota, or null when there is no such offer. Pass raw account state, not the
 * resolver's view: that one counts Codex as usable while Rome credits pay, and
 * this switch must never lead to spending credits (#1409).
 */
export function quotaSwitchTarget(
  state: AIToolStateValue,
  from: AIToolProviderId,
  tier: ModelTier,
  concierge = false,
): { provider: AIToolProviderId; selectionId: ModelSelectionId } | null {
  const current = from === "openai" ? state.codex : state.claude;
  if (!current.quotaExhausted) return null;
  const provider = from === "openai" ? "anthropic" : "openai";
  const target = provider === "openai" ? state.codex : state.claude;
  if (target.loggedIn !== true || target.quotaExhausted || target.needsReauth) return null;
  if (provider === "anthropic") {
    if (claudeUsesApiKey(target)) return null;
    return {
      provider,
      selectionId:
        concierge || tier === "medium"
          ? "claude-sonnet"
          : tier === "small"
            ? "claude-haiku"
            : "claude-opus-5-5",
    };
  }
  if (target.accountType === "api_key") return null;
  return {
    provider,
    selectionId:
      concierge || tier === "small"
        ? state.codex.lunaAccess
          ? "gpt-6-luna"
          : "gpt-5-6-terra"
        : state.codex.solAccess
          ? "gpt-6-1-sol"
          : "gpt-5-6-terra",
  };
}
