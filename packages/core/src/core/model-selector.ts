import {
  WEBCHAT_LARGE_MODEL_SELECTIONS,
  type WebchatLargeModelSelectionId,
  type WebchatLargeModelSelection,
} from "@rome/api-types/model-selection";
import type { ModelReasoningEffort } from "./agent-runner.js";
import { DEFAULT_REASONING_EFFORT } from "@rome-os/app-runtime";

export const ENABLE_MODEL_SELECTOR_SETTING_KEY = "enableModelSelector";
export const WEBCHAT_LARGE_MODEL_SETTING_KEY = "webchatLargeModel";
export const WEBCHAT_REASONING_EFFORT_SETTING_KEY = "webchatReasoningEffort";

export {
  WEBCHAT_LARGE_MODEL_SELECTIONS,
  type WebchatLargeModelSelectionId,
  type WebchatLargeModelSelection,
  type ModelSelectionId,
} from "@rome/api-types/model-selection";

export const DEFAULT_WEBCHAT_LARGE_MODEL_SELECTION: WebchatLargeModelSelectionId = "auto";
export const DEFAULT_WEBCHAT_REASONING_EFFORT =
  DEFAULT_REASONING_EFFORT satisfies ModelReasoningEffort;

export function normalizeWebchatLargeModelSelectionId(
  value: unknown,
): WebchatLargeModelSelectionId {
  return typeof value === "string" && (value === "auto" || value in WEBCHAT_LARGE_MODEL_SELECTIONS)
    ? (value as WebchatLargeModelSelectionId)
    : DEFAULT_WEBCHAT_LARGE_MODEL_SELECTION;
}

export function resolveWebchatLargeModelSelection(
  value: unknown,
): WebchatLargeModelSelection | null {
  const id = normalizeWebchatLargeModelSelectionId(value);
  return id === "auto" ? null : WEBCHAT_LARGE_MODEL_SELECTIONS[id];
}

export function normalizeWebchatReasoningEffort(value: unknown): ModelReasoningEffort {
  return value === "low" || value === "high" || value === "xhigh"
    ? value
    : DEFAULT_WEBCHAT_REASONING_EFFORT;
}
