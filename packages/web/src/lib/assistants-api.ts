import type { Assistant, AssistantList } from "@rome/api-types/assistants";
import type { OutboxMessage, TimelinePage } from "@rome/api-types/people";
import { fetchJson } from "@/lib/fetch-json";

// Assistants: a Dot, Muse or another Rome talking to Rome through Rome Cloud,
// each one chat (docs/domains/chats.md#assistant). The server reads their
// history and sends through the same timeline and outbox as People.

/** The search parameter on `/assistants` naming the open chat. */
export const ASSISTANT_PARAM = "id";

/** The API path of one assistant's chat. */
function apiPath(agentId: string): string {
  return `/api/assistants/${encodeURIComponent(agentId)}`;
}

export async function listAssistants(signal?: AbortSignal): Promise<Assistant[]> {
  const data = await fetchJson<AssistantList>("/api/assistants", {
    signal,
    fallback: "Could not load assistants",
  });
  return data.assistants;
}

export function readAssistantMessages(
  agentId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<TimelinePage> {
  const search = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return fetchJson<TimelinePage>(`${apiPath(agentId)}/messages${search}`, {
    signal,
    fallback: "Could not load messages",
  });
}

/** Give up on a send the channel refused, so it does not stay in the
 *  outbox; the guardian's retry is then a new message. */
export function discardAssistantSend(agentId: string, sendId: string): Promise<void> {
  return fetchJson<void>(`${apiPath(agentId)}/outbox/${encodeURIComponent(sendId)}`, {
    method: "DELETE",
    fallback: "Could not discard the message",
  });
}

/** Write to the assistant as the guardian. Resolves to the outbox row, whose
 *  `state` says whether the channel took it. */
export function sendToAssistant(agentId: string, text: string, id: string): Promise<OutboxMessage> {
  return fetchJson<OutboxMessage>(`${apiPath(agentId)}/messages`, {
    method: "POST",
    json: { text, id },
    fallback: "Could not send",
  });
}
