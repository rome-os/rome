/**
 * The kinds of connection whose accounts can be linked to an agent: the bots a guardian
 * adds to chats on behalf of an agent, and the signed-in Telegram user. A
 * channel that carries Rome's own traffic (the Cloud `agents` channel, webchat,
 * email) takes no link. Core checks it when it links an agent, and the
 * dashboard reads it to offer the picker. Invariants:
 * docs/architecture/channels.md#an-accounts-agent.
 */
export const LINKABLE_KINDS: ReadonlySet<string> = new Set([
  "feishu",
  "telegram",
  "discord",
  "telegram_user",
  "slack_bot",
]);

/** The canonical id of main, the id core stores when main is linked. Main is
 *  linked to an account like any agent. */
export const MAIN_AGENT_ID = "core:main";

/** The canonical id of an agent named in a request or a URL. `/api/agents` and
 *  the link route also know main by its short name, `main`. */
export function canonicalAgent(name: string): string {
  return name === "main" ? MAIN_AGENT_ID : name;
}

/** The name an agent is shown under: main by its short name, any other agent
 *  by its canonical id. */
export function agentLabel(agent: string): string {
  return agent === MAIN_AGENT_ID ? "main" : agent;
}
