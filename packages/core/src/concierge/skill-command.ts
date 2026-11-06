import type { SlashSkillInvocation } from "../core/slash-skill-command.js";

/** Delegate an explicit skill invocation without loading it into Concierge. */
export function buildConciergeSkillPrompt(invocation: SlashSkillInvocation): string {
  const brief = invocation.task || "Ask the guardian what they want to do with this skill.";
  return (
    `The guardian explicitly invoked the skill ${JSON.stringify(invocation.skillName)} via a slash command. ` +
    "Do not read or run the skill yourself. Acknowledge with `say` first, then start a task chat " +
    "with the main agent using `chat_start` and these arguments (add a short title):\n\n" +
    JSON.stringify({ agent: "main", skill: invocation.skillName, brief })
  );
}
