import type { ReasoningEffort } from "./chat-types";

export const DEFAULT_PROJECT_NAME = "default";
export const SCROLL_BOTTOM_THRESHOLD_PX = 96;

export const DEFAULT_LARGE_MODEL_SELECTION = "auto";

// Models group under a family in the picker so the full list stays scannable
// as releases pile up (issue #180). `auto` is deliberately family-less: it is
// the special first row, pinned above every family group and its short list.
export type LargeModelFamily = "claude" | "gpt";

export interface LargeModelOption {
  id: string;
  labelKey: string;
  /** Omitted for `auto`, the pinned first row that sits above the families. */
  family?: LargeModelFamily;
}

// Order matters twice: `auto` stays first, and within a family the newest
// generation is listed first so it sits at the top of that family's group.
export const LARGE_MODEL_OPTIONS: readonly LargeModelOption[] = [
  { id: "auto", labelKey: "modelSelector.options.auto" },
  { id: "claude-opus-5", labelKey: "modelSelector.options.opus5", family: "claude" },
  { id: "claude-opus-4-6", labelKey: "modelSelector.options.opus46", family: "claude" },
  { id: "claude-opus", labelKey: "modelSelector.options.claudeOpus", family: "claude" },
  { id: "claude-sonnet", labelKey: "modelSelector.options.sonnet", family: "claude" },
  { id: "claude-haiku", labelKey: "modelSelector.options.haiku", family: "claude" },
  { id: "claude-fable", labelKey: "modelSelector.options.fable", family: "claude" },
  { id: "gpt-6-astra", labelKey: "modelSelector.options.gpt6Astra", family: "gpt" },
  { id: "gpt-5-6-sol", labelKey: "modelSelector.options.gpt56Sol", family: "gpt" },
  { id: "gpt-5-6-terra", labelKey: "modelSelector.options.gpt56Terra", family: "gpt" },
  { id: "gpt-5-6-luna", labelKey: "modelSelector.options.gpt56Luna", family: "gpt" },
];

// Family render order + heading keys for the expanded / searched list. The
// per-family generation order lives in LARGE_MODEL_OPTIONS above.
export const LARGE_MODEL_FAMILY_ORDER: readonly LargeModelFamily[] = ["claude", "gpt"];
export const LARGE_MODEL_FAMILY_LABEL_KEYS: Record<LargeModelFamily, string> = {
  claude: "modelSelector.families.claude",
  gpt: "modelSelector.families.gpt",
};

// The short list shown before the guardian expands ("show all") or searches.
// Hand-curated on purpose: the client has no usage data to say which models
// are common (issue #180), so this is an editorial default — `auto` plus one
// current flagship per family. Revisit once real usage data exists; editing
// this list is a one-line change and needs no other code change. Any id here
// that is not a real option is ignored, and the currently selected model is
// always shown even when it is absent from this list.
export const COMMON_LARGE_MODEL_IDS: readonly string[] = [
  "auto",
  "claude-opus-5",
  "claude-sonnet",
  "gpt-6-astra",
];

export const DEFAULT_REASONING_EFFORT = "high" satisfies ReasoningEffort;
export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  id: ReasoningEffort;
  labelKey: string;
}> = [
  { id: "low", labelKey: "reasoningEffort.options.fast" },
  { id: "high", labelKey: "reasoningEffort.options.think" },
  { id: "xhigh", labelKey: "reasoningEffort.options.ultrathink" },
];
