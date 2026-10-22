import { http, HttpResponse } from "msw";
import {
  compareAssistants,
  parseAssistantSendRequest,
  type Assistant,
  type AssistantList,
} from "@rome/api-types/assistants";
import type { Message } from "@rome/api-types/message";
import type { OutboxMessage, OutboxPage, TimelinePage } from "@rome/api-types/people";

// Assistants: a Dot and a Muse listed by Rome Cloud. The Dot has a short chat
// with Rome; Muse has none yet, so the empty chat and writing first are both
// reachable. A send lands on the chat at once, as on a channel Rome records
// itself.

const DOT = "5f0c2a1e-7b3d-4c8e-9a6f-1d2e3f4a5b6c";
const MUSE = "a9b8c7d6-e5f4-4a3b-8c2d-1e0f9a8b7c6d";

const now = Math.floor(Date.now() / 1000);

const assistants: Omit<Assistant, "lastMessageAt">[] = [
  { agentId: DOT, name: "Research dot", kind: "dot", account: "demo", sameAccount: true },
  { agentId: MUSE, name: "Muse", kind: "muse", account: "demo", sameAccount: true },
];

/** Newest last, as said. */
const chats = new Map<string, Message[]>([
  [
    DOT,
    [
      line(DOT, "inbound", now - 3600, "Can you check whether the Q3 report draft is in Projects?"),
      line(
        DOT,
        "outbound",
        now - 3540,
        "Yes. It is in Projects → Reports → q3-draft.md, last edited yesterday.",
      ),
      line(DOT, "inbound", now - 600, "Thanks. Please summarise its open questions."),
    ],
  ],
]);

let sent = 0;

function line(agentId: string, direction: Message["direction"], at: number, body: string): Message {
  const name = assistants.find((assistant) => assistant.agentId === agentId)?.name ?? null;
  return {
    source: "agents",
    timestamp: at,
    body,
    direction,
    ref: `${agentId}:${direction}-${at}`,
    sender: direction === "outbound" ? { id: "rome", name: "Rome" } : { id: agentId, name },
  };
}

export const assistantHandlers = [
  http.get("/api/assistants", () =>
    HttpResponse.json({
      assistants: assistants
        .map((assistant) => ({
          ...assistant,
          lastMessageAt: chats.get(assistant.agentId)?.at(-1)?.timestamp ?? null,
        }))
        .sort(compareAssistants),
    } satisfies AssistantList),
  ),

  http.get("/api/assistants/:agentId/messages", ({ params }) =>
    HttpResponse.json({
      entries: [...(chats.get(String(params.agentId)) ?? [])].reverse(),
      nextCursor: null,
    } satisfies TimelinePage),
  ),

  http.post("/api/assistants/:agentId/messages", async ({ params, request }) => {
    const agentId = String(params.agentId);
    if (!assistants.some((assistant) => assistant.agentId === agentId)) {
      return HttpResponse.json({ error: "Unknown assistant" }, { status: 404 });
    }
    const parsed = parseAssistantSendRequest(await request.json().catch(() => null));
    if ("error" in parsed) return HttpResponse.json({ error: parsed.error }, { status: 400 });

    const at = Math.floor(Date.now() / 1000);
    const entry = line(agentId, "outbound", at, parsed.request.text);
    chats.set(agentId, [...(chats.get(agentId) ?? []), entry]);
    return HttpResponse.json(
      {
        id: parsed.request.id ?? `mock-send-${++sent}`,
        channel: "agents",
        channelUserId: agentId,
        text: parsed.request.text,
        timestamp: at,
        state: "unconfirmed",
        ref: entry.ref,
        error: null,
        dismissable: false,
      } satisfies OutboxMessage,
      { status: 202 },
    );
  }),

  http.get("/api/assistants/:agentId/outbox", () =>
    HttpResponse.json({ messages: [] } satisfies OutboxPage),
  ),
];
