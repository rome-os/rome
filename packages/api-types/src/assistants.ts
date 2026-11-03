// Assistants: agents outside Rome, such as a Dot, Muse or another Rome, that
// talk to Rome through Rome Cloud. Each is one chat with Rome
// (docs/domains/chats.md#assistant). The dashboard shows their chats on one
// Assistants page and writes to them as the guardian, which wakes no agent.

/** What kind of assistant Rome Cloud says it is. Cloud may add kinds before
 *  this Rome knows them, so any other string is kept and shown as it is. */
export type AssistantKind = "dot" | "muse" | "rome" | (string & {});

/**
 * Whether an agent Rome Cloud lists is shown as an assistant. Another Rome is
 * not, for now: talking to another Rome is not a feature of its own yet, and
 * every Rome in the account, stale ones included, would fill the group
 * (docs/domains/chats.md#assistant).
 */
export function listsAsAssistant(agent: { kind: string }): boolean {
  return agent.kind !== "rome";
}

export interface Assistant {
  /** Rome Cloud's id for it, which never changes. Also its chat's address. */
  agentId: string;
  /** Its name now. Its owner can change it, and two may share one. */
  name: string;
  kind: AssistantKind;
  /** Its owner's handle on Rome Cloud. */
  account: string;
  /** False for an assistant of another account linked to this Rome's. */
  sameAccount: boolean;
  /** Epoch seconds of the newest message in its chat, or null before any. */
  lastMessageAt: number | null;
}

export interface AssistantList {
  assistants: Assistant[];
}

/** The newest chat first, then the ones nobody has written in yet, by name. */
export function compareAssistants(a: Assistant, b: Assistant): number {
  const at = (assistant: Assistant) => assistant.lastMessageAt ?? -1;
  if (at(a) !== at(b)) return at(b) - at(a);
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
}

export interface AssistantSendRequest {
  text: string;
}

export function parseAssistantSendRequest(
  body: unknown,
): { request: AssistantSendRequest } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const raw = body as Record<string, unknown>;
  if (typeof raw.text !== "string" || raw.text.trim() === "") {
    return { error: "text must be a non-empty string" };
  }
  return { request: { text: raw.text } };
}
