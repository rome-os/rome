/**
 * Apps Rome cannot start without, even when no core agent references their
 * subagents. `system` provides the core action set; the others are baseline
 * capabilities the runtime depends on.
 */
export const ALWAYS_REQUIRED_APPS = [
  "system",
  "assistant",
  "coding",
  "inbox",
  "browser-automation",
  "connector",
  // Guardian-facing skills surface: browse/invoke + import/generate.
  "skills",
] as const;
