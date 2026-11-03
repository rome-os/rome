import type { Assistant, AssistantList } from "@rome/api-types/assistants";
import type { SentMessage, TimelinePage } from "@rome/api-types/people";
import { fetchJson } from "@/lib/fetch-json";

// Assistants: a Dot, Muse or another Rome talking to Rome through Rome Cloud,
// each one chat (docs/domains/chats.md#assistant). The server reads their
// history and sends through the same timeline and send as People.

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

/** Write to the assistant as the guardian. Resolves once the channel took the
 *  message, and rejects with the channel's own words when it refused. */
export function sendToAssistant(agentId: string, text: string): Promise<SentMessage> {
  return fetchJson<SentMessage>(`${apiPath(agentId)}/messages`, {
    method: "POST",
    json: { text },
    fallback: "Could not send",
  });
}
