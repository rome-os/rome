import type { DefaultModelProvider } from "@rome/api-types/chat";
import type { ReasoningEffort } from "./chat-types";

export const DEFAULT_PROJECT_NAME = "default";

export const DEFAULT_LARGE_MODEL_SELECTION = "auto";
export const LARGE_MODEL_OPTIONS = [
  { id: "auto", labelKey: "modelSelector.options.auto" },
  { id: "claude-opus", labelKey: "modelSelector.options.claudeOpus" },
  { id: "claude-opus-5-5", labelKey: "modelSelector.options.opus55" },
  { id: "claude-opus-5", labelKey: "modelSelector.options.opus5" },
  { id: "claude-opus-4-6", labelKey: "modelSelector.options.opus46" },
  { id: "claude-sonnet", labelKey: "modelSelector.options.sonnet" },
  { id: "claude-haiku", labelKey: "modelSelector.options.haiku" },
  { id: "claude-fable", labelKey: "modelSelector.options.fable" },
  { id: "gpt-6-astra", labelKey: "modelSelector.options.gpt6Astra" },
  { id: "gpt-6-1-sol", labelKey: "modelSelector.options.gpt61Sol" },
  { id: "gpt-6-sol", labelKey: "modelSelector.options.gpt6Sol" },
  { id: "gpt-6-luna", labelKey: "modelSelector.options.gpt6Luna" },
  { id: "gpt-5-6-sol", labelKey: "modelSelector.options.gpt56Sol" },
  { id: "gpt-5-6-terra", labelKey: "modelSelector.options.gpt56Terra" },
  { id: "gpt-5-6-luna", labelKey: "modelSelector.options.gpt56Luna" },
] as const;

// The curated "commonly used" subset the model menu shows before the guardian
// expands it or types to filter. Nothing in the client records which models a
// guardian actually reaches for, so this list is hand-picked (see #180): the
// automatic choice plus the latest-generation flagship of each provider family
// — Claude Opus 5.5 and GPT-6 Astra (the newest OpenAI generation in the
// catalog above). Every other model stays one "show all" click (or a few
// keystrokes) away, and a deliberately pinned model is always shown too, so
// nothing is stranded. Revisit this set once real usage data exists.
//
// Typed against the catalog's id union (not `string[]`) so a typo, or retiring
// or renaming a model in LARGE_MODEL_OPTIONS, is a typecheck error rather than a
// silent drop from the curated set — `.includes(option.id)` still narrows fine
// because option.id is a member of the same union.
export const COMMON_LARGE_MODEL_IDS: ReadonlyArray<(typeof LARGE_MODEL_OPTIONS)[number]["id"]> = [
  "auto",
  "claude-opus-5-5",
  "gpt-6-astra",
];

/** Which provider family runs a model id: claude-* on Claude, gpt-* on ChatGPT. */
export function modelFamily(modelId: string): "anthropic" | "openai" | null {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gpt-")) return "openai";
  return null;
}

/**
 * Whether a model can run with the providers signed in. Rome credits run
 * ChatGPT models. An unknown sign-in state (null) hides nothing.
 */
export function canRunModel(
  modelId: string,
  signedIn: Record<DefaultModelProvider, boolean> | null | undefined,
): boolean {
  if (!signedIn) return true;
  const family = modelFamily(modelId);
  if (family === "anthropic") return signedIn.anthropic;
  if (family === "openai") return signedIn.openai || signedIn.rome_credits;
  return true;
}

/**
 * The model options to offer: models of signed-in providers, plus `selected`
 * so a chat's own pick stays visible after its provider signs out.
 */
export function runnableLargeModelOptions(
  signedIn: Record<DefaultModelProvider, boolean> | null | undefined,
  selected: string,
): ReadonlyArray<(typeof LARGE_MODEL_OPTIONS)[number]> {
  return LARGE_MODEL_OPTIONS.filter(
    (option) => option.id === selected || canRunModel(option.id, signedIn),
  );
}

export const DEFAULT_REASONING_EFFORT = "high" satisfies ReasoningEffort;
export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  id: ReasoningEffort;
  labelKey: string;
}> = [
  { id: "low", labelKey: "reasoningEffort.options.fast" },
  { id: "high", labelKey: "reasoningEffort.options.think" },
  { id: "xhigh", labelKey: "reasoningEffort.options.ultrathink" },
];
