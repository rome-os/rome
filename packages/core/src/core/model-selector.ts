import type { ModelReasoningEffort, ProviderId } from "./agent-runner.js";
import { DEFAULT_REASONING_EFFORT } from "@rome-os/app-runtime";

export const ENABLE_MODEL_SELECTOR_SETTING_KEY = "enableModelSelector";
export const WEBCHAT_LARGE_MODEL_SETTING_KEY = "webchatLargeModel";
export const WEBCHAT_REASONING_EFFORT_SETTING_KEY = "webchatReasoningEffort";

export type WebchatLargeModelSelectionId =
  | "auto"
  | "claude-opus"
  | "claude-opus-5"
  | "claude-opus-4-6"
  | "claude-sonnet"
  | "claude-haiku"
  | "claude-fable"
  | "gpt-6-astra"
  | "gpt-5-6-sol"
  | "gpt-5-6-terra"
  | "gpt-5-6-luna";

export type ModelSelectionId = Exclude<WebchatLargeModelSelectionId, "auto">;

export interface WebchatLargeModelSelection {
  id: ModelSelectionId;
  providerId: ProviderId;
  model: string;
}

export const DEFAULT_WEBCHAT_LARGE_MODEL_SELECTION: WebchatLargeModelSelectionId = "auto";
export const DEFAULT_WEBCHAT_REASONING_EFFORT =
  DEFAULT_REASONING_EFFORT satisfies ModelReasoningEffort;

export const WEBCHAT_LARGE_MODEL_SELECTIONS: Record<ModelSelectionId, WebchatLargeModelSelection> =
  {
    "claude-opus": {
      id: "claude-opus",
      providerId: "anthropic",
      model: "claude-opus-4-8[1m]",
    },
    "claude-opus-5": {
      id: "claude-opus-5",
      providerId: "anthropic",
      model: "claude-opus-5[1m]",
    },
    "claude-opus-4-6": {
      id: "claude-opus-4-6",
      providerId: "anthropic",
      model: "claude-opus-4-6[1m]",
    },
    "claude-sonnet": {
      id: "claude-sonnet",
      providerId: "anthropic",
      model: "claude-sonnet-5",
    },
    "claude-haiku": {
      id: "claude-haiku",
      providerId: "anthropic",
      model: "claude-haiku-4-5",
    },
    "claude-fable": {
      id: "claude-fable",
      providerId: "anthropic",
      model: "claude-fable-5-1[1m]",
    },
    "gpt-6-astra": {
      id: "gpt-6-astra",
      providerId: "openai",
      model: "gpt-6-astra",
    },
    "gpt-5-6-sol": {
      id: "gpt-5-6-sol",
      providerId: "openai",
      model: "gpt-5.6-sol",
    },
    "gpt-5-6-terra": {
      id: "gpt-5-6-terra",
      providerId: "openai",
      model: "gpt-5.6-terra",
    },
    "gpt-5-6-luna": {
      id: "gpt-5-6-luna",
      providerId: "openai",
      model: "gpt-5.6-luna",
    },
  };

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
