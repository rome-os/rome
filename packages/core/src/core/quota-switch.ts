import { claudeUsesApiKey, type AIToolProviderId, type AIToolStateValue } from "./ai-tool-state.js";
import type { ModelSelectionId } from "./model-selector.js";

export function soleExhaustedProvider(state: AIToolStateValue): AIToolProviderId | null {
  if (state.codex.quotaExhausted === state.claude.quotaExhausted) return null;
  return state.codex.quotaExhausted ? "openai" : "anthropic";
}

/** Pass raw account state: resolver availability can include Rome credits. */
export function quotaSwitchTarget(
  state: AIToolStateValue,
  from: AIToolProviderId,
): { provider: AIToolProviderId; selectionId: ModelSelectionId } | null {
  if (!(from === "openai" ? state.codex : state.claude).quotaExhausted) return null;
  const provider = from === "openai" ? "anthropic" : "openai";
  const target = provider === "openai" ? state.codex : state.claude;
  if (target.loggedIn !== true || target.quotaExhausted || target.needsReauth) return null;
  if (provider === "anthropic") {
    return claudeUsesApiKey(target) ? null : { provider, selectionId: "claude-sonnet" };
  }
  return target.accountType === "api_key"
    ? null
    : {
        provider,
        selectionId: state.codex.lunaAccess ? "gpt-6-luna" : "gpt-5-6-terra",
      };
}
