/**
 * The kind of link an account's agent has, which its kind of connection
 * decides: `own_account` for an account made for the agent, such as a bot, so
 * the agent speaks as it, and `delegate` for the guardian's own signed-in
 * account, which the agent answers from on the guardian's behalf. A kind of
 * connection that declares none takes no agent. Vocabulary:
 * docs/domains/chats.md#own-account and docs/domains/chats.md#delegate.
 */
export type AccountLink = "own_account" | "delegate";

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
