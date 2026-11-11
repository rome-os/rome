import type { SlashSkillInvocation } from "../agent/index.js";

/** Delegate an explicit skill invocation without loading it into Concierge. */
export function buildConciergeSkillPrompt(invocation: SlashSkillInvocation): string {
  const skill = JSON.stringify(invocation.skillName);
  const header =
    `The guardian explicitly invoked the skill ${skill} via a slash command. ` +
    "Do not read or run the skill yourself: a task chat does. Call `chat_start` right away " +
    `with \`agent: "main"\`, \`skill: ${skill}\`, a short title and an \`ack\`, your one-line acknowledgement. ` +
    "Do not `say` an acknowledgement first: `chat_start` sends it, with a card for the task. " +
    "Write the brief as for any task: the guardian's request, plus any context from this " +
    "conversation or a quoted message that the task chat needs.";
  if (!invocation.task) {
    return `${header}\n\nThe guardian did not include any task text. Say so in the brief, so the task chat asks them what they want to do with the skill.`;
  }
  return `${header}\n\nRequest: ${invocation.task}`;
}
