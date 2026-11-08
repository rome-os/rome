import type { SkillCatalog } from "./skill.js";

/**
 * Slash-command skill invocation. A guardian message whose first
 * token is `/<skill-name>` — where the name matches a catalog skill exactly —
 * explicitly invokes that skill for the turn.
 *
 * Expansion is server-side at turn intake so any channel can reuse it. It
 * injects *intent*, not skill content: the agent is told to `read_skill`, so
 * prompt size stays flat and the catalog remains the single source of truth.
 * The raw `/name task` text is what gets persisted for display; only the
 * model-visible prompt is rewritten.
 *
 * A leading `/` that matches no catalog skill passes through untouched —
 * `/etc/hosts looks wrong` is a normal message, not an error.
 */

// The catalog is the authority for whether a token names a skill. Keep the
// tokenizer deliberately shape-agnostic so canonical ids whose app namespace
// contains `/` (for example `@publisher/app:skill`) follow the same path as
// unscoped ids without duplicating the app-id grammar here.
const SLASH_COMMAND_PATTERN = /^\/(\S+)(?:\s+([\s\S]*))?$/;

export interface SlashSkillInvocation {
  skillName: string;
  task: string;
}

/** Parse `/<token> [task]` from a guardian message. Returns null when the
 * message is not slash-shaped or the token names no catalog skill. */
export function parseSlashSkillInvocation(
  text: string,
  catalog: Pick<SkillCatalog, "find">,
): SlashSkillInvocation | null {
  const match = text.trimStart().match(SLASH_COMMAND_PATTERN);
  if (!match) return null;
  const skillName = match[1];
  const skill = catalog.find(skillName);
  if (!skill) return null;
  return { skillName: skill.name, task: match[2]?.trim() ?? "" };
}

/** The model-visible prompt for a slash-skill turn. */
export function buildSlashSkillPrompt(invocation: SlashSkillInvocation): string {
  const header =
    `The guardian explicitly invoked the skill "${invocation.skillName}" for this turn ` +
    `via a slash command. Read it now with the \`read_skill\` tool and follow its ` +
    `instructions for this turn.`;
  if (!invocation.task) {
    return `${header}\n\nThe guardian did not include any task text — after reading the skill, ask what they want to do with it.`;
  }
  return `${header}\n\nTask: ${invocation.task}`;
}
