import type { ReasoningEffort } from "./chat-types";

export const DEFAULT_PROJECT_NAME = "default";
export const SCROLL_BOTTOM_THRESHOLD_PX = 96;

export const DEFAULT_LARGE_MODEL_SELECTION = "auto";
export const LARGE_MODEL_OPTIONS = [
  { id: "auto", labelKey: "modelSelector.options.auto" },
  { id: "claude-opus", labelKey: "modelSelector.options.claudeOpus" },
  { id: "claude-opus-5", labelKey: "modelSelector.options.opus5" },
  { id: "claude-opus-4-6", labelKey: "modelSelector.options.opus46" },
  { id: "claude-sonnet", labelKey: "modelSelector.options.sonnet" },
  { id: "claude-haiku", labelKey: "modelSelector.options.haiku" },
  { id: "claude-fable", labelKey: "modelSelector.options.fable" },
  { id: "gpt-6-astra", labelKey: "modelSelector.options.gpt6Astra" },
  { id: "gpt-5-6-sol", labelKey: "modelSelector.options.gpt56Sol" },
  { id: "gpt-5-6-terra", labelKey: "modelSelector.options.gpt56Terra" },
  { id: "gpt-5-6-luna", labelKey: "modelSelector.options.gpt56Luna" },
] as const;

export const DEFAULT_REASONING_EFFORT = "high" satisfies ReasoningEffort;
export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  id: ReasoningEffort;
  labelKey: string;
}> = [
  { id: "low", labelKey: "reasoningEffort.options.fast" },
  { id: "high", labelKey: "reasoningEffort.options.think" },
  { id: "xhigh", labelKey: "reasoningEffort.options.ultrathink" },
];
