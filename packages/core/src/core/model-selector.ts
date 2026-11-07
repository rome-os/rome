import type { ModelReasoningEffort } from "./agent-runner.js";
import { DEFAULT_REASONING_EFFORT } from "@rome-os/app-runtime";
import {
  isModelSelectionId,
  MODEL_SELECTIONS,
  type ModelSelection,
  type ModelSelectionId,
} from "../agent/index.js";

// The webchat settings that pick a model, and how a stored value reads as a
// selection. The selections themselves are the agent context's
// (`ModelSelection`); "auto" is the setting's word for leaving the choice to
// the resolver.

export const ENABLE_MODEL_SELECTOR_SETTING_KEY = "enableModelSelector";
export const WEBCHAT_LARGE_MODEL_SETTING_KEY = "webchatLargeModel";
export const WEBCHAT_REASONING_EFFORT_SETTING_KEY = "webchatReasoningEffort";

export type WebchatLargeModelSelectionId = "auto" | ModelSelectionId;

export const DEFAULT_WEBCHAT_LARGE_MODEL_SELECTION: WebchatLargeModelSelectionId = "auto";
export const DEFAULT_WEBCHAT_REASONING_EFFORT =
  DEFAULT_REASONING_EFFORT satisfies ModelReasoningEffort;

export function normalizeWebchatLargeModelSelectionId(
  value: unknown,
): WebchatLargeModelSelectionId {
  return value === "auto" || isModelSelectionId(value)
    ? value
    : DEFAULT_WEBCHAT_LARGE_MODEL_SELECTION;
}

export function resolveWebchatLargeModelSelection(value: unknown): ModelSelection | null {
  const id = normalizeWebchatLargeModelSelectionId(value);
  return id === "auto" ? null : MODEL_SELECTIONS[id];
}

export function normalizeWebchatReasoningEffort(value: unknown): ModelReasoningEffort {
  return value === "low" || value === "high" || value === "xhigh"
    ? value
    : DEFAULT_WEBCHAT_REASONING_EFFORT;
}
