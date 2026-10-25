// The empty composer's placeholder: one hint at a time about what the box can
// do. Each hint names a feature only where it works, so a phone never reads a
// keyboard shortcut and an open chat never offers the `@` agent picker.

export type ComposerHint =
  | "default"
  | "skill"
  | "agent"
  | "project"
  | "attach"
  | "newline"
  | "search"
  | "sendWhileWorking";

/** i18n key in the `chat` namespace; `search` takes a `shortcut` value. */
export const COMPOSER_HINT_KEYS: Record<ComposerHint, string> = {
  default: "composer.placeholderDefault",
  skill: "composer.hints.skill",
  agent: "composer.hints.agent",
  project: "composer.hints.project",
  attach: "composer.hints.attach",
  newline: "composer.hints.newline",
  search: "composer.hints.search",
  sendWhileWorking: "composer.hints.sendWhileWorking",
};

export interface ComposerHintContext {
  /** A new chat, before its first turn; an open chat has its agent fixed. */
  draft: boolean;
  /** The plain-text box with no skills or attachments. */
  textOnly: boolean;
  /** The project picker is on screen. */
  projectSelector: boolean;
  /** Touch-first device: no hardware keyboard shortcuts, no drag and drop. */
  coarsePointer: boolean;
}

export function composerHints(context: ComposerHintContext): ComposerHint[] {
  const { draft, textOnly, projectSelector, coarsePointer } = context;
  const hints: ComposerHint[] = draft ? ["default"] : [];
  if (!textOnly) hints.push("skill");
  if (draft) hints.push("agent");
  if (draft && projectSelector) hints.push("project");
  if (!textOnly && !coarsePointer) hints.push("attach");
  if (!coarsePointer) hints.push("newline", "search");
  if (!draft) hints.push("sendWhileWorking");
  return hints;
}

/**
 * Picks the next hint at random, never the one just shown, so a new chat or a
 * sent message shows something different without cycling under the reader.
 */
export function pickComposerHint(
  hints: readonly ComposerHint[],
  previous: ComposerHint | null,
  random: () => number = Math.random,
): ComposerHint {
  const pool = hints.length > 1 ? hints.filter((hint) => hint !== previous) : hints;
  return pool[Math.floor(random() * pool.length)] ?? "default";
}
