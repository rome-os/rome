import { claudeUsesApiKey, type AIToolProviderId, type AIToolStateValue } from "./ai-tool-state.js";
import type { ModelSelectionId } from "../agent/index.js";

export function soleExhaustedProvider(state: AIToolStateValue): AIToolProviderId | null {
  if (state.codex.quotaExhausted === state.claude.quotaExhausted) return null;
  return state.codex.quotaExhausted ? "openai" : "anthropic";
}

/** Pass raw account state: resolver availability can include Rome credits. */
export function quotaSwitchTarget(
  state: AIToolStateValue,
  from: AIToolProviderId,
  failed = false,
): { provider: AIToolProviderId; selectionId: ModelSelectionId } | null {
  if (from === "anthropic" ? claudeUsesApiKey(state.claude) : state.codex.accountType === "api_key")
    return null;
  if (!failed && !(from === "openai" ? state.codex : state.claude).quotaExhausted) return null;
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

export function sameProviderTarget(state: AIToolStateValue, from: AIToolProviderId, model: string) {
  const source = from === "openai" ? state.codex : state.claude;
  if (source.loggedIn !== true || source.quotaExhausted || source.needsReauth) return null;
  if (from === "anthropic" ? claudeUsesApiKey(source) : source.accountType === "api_key")
    return null;
  let selectionId: ModelSelectionId;
  if (from === "anthropic") {
    if (/sonnet/.test(model)) selectionId = "claude-opus-5-5";
    else if (/opus|fable|haiku/.test(model)) selectionId = "claude-sonnet";
    else return null;
  } else if (/luna/.test(model)) selectionId = "gpt-5-6-terra";
  else if (/terra/.test(model)) {
    if (!state.codex.lunaAccess) return null;
    selectionId = "gpt-6-luna";
  } else if (/sol|astra/.test(model))
    selectionId = state.codex.lunaAccess ? "gpt-6-luna" : "gpt-5-6-terra";
  else return null;
  return { provider: from, selectionId };
}
