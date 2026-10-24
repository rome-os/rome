// Human-facing names for provider model ids and effort levels. Unknown ids
// pass through unchanged so a new model still shows something truthful.

const CONTEXT_TAG = /\[[^\]]*\]$/;
const DATE_STAMP = /-\d{8}$/;

const CLAUDE = /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?$/;
const CLAUDE_LEGACY = /^claude-(\d+)(?:[-.](\d+))?-(opus|sonnet|haiku)$/;
const GPT = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/;
const GEMINI = /^gemini-(\d+(?:\.\d+)*)(?:-(.+))?$/;

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function version(major: string, minor: string | undefined): string {
  return minor ? `${major}.${minor}` : major;
}

function variant(rest: string | undefined): string {
  return rest ? ` ${rest.split("-").map(capitalize).join(" ")}` : "";
}

/** `claude-opus-5-5[1m]` → `Opus 5.5`, `gpt-5.6-sol` → `GPT-5.6 Sol`. */
export function formatModelName(model: string): string {
  // The context-window tag and the snapshot date are not part of the name.
  const id = model.trim().toLowerCase().replace(CONTEXT_TAG, "").replace(DATE_STAMP, "");

  const claude = CLAUDE.exec(id);
  if (claude) return `${capitalize(claude[1])} ${version(claude[2], claude[3])}`;
  const legacy = CLAUDE_LEGACY.exec(id);
  if (legacy) return `${capitalize(legacy[3])} ${version(legacy[1], legacy[2])}`;
  const gpt = GPT.exec(id);
  if (gpt) return `GPT-${gpt[1]}${variant(gpt[2])}`;
  const gemini = GEMINI.exec(id);
  if (gemini) return `Gemini ${gemini[1]}${variant(gemini[2])}`;
  return model;
}

/** `high` → `High`, `xhigh` → `Extra High`. */
export function formatReasoningEffort(effort: string): string {
  const key = effort.trim().toLowerCase();
  return EFFORT_LABELS[key] ?? capitalize(key);
}
