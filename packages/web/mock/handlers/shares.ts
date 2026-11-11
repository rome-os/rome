import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { http, HttpResponse } from "msw";
import { CONCIERGE_AGENT_ID } from "@/hooks/use-concierge";
import type { ChatMessage, ChatSession } from "@/lib/chat-types";
import type { SharedChatPayload } from "@/lib/chat-api";

// Share links, held in memory: a chat's selected turns, or one message's text
// alone, frozen at share time and read back on `/share/:token`. Mirrors
// `/chat/sessions/:id/share`, `/chat/sessions/:id/messages/:messageId/share`,
// the listing and the revoke in packages/core/src/api/routes/webchat.ts, and
// the public read in share.ts.

interface MockShare {
  sessionId: string;
  messageId?: string;
  createdAt: string;
  payload: SharedChatPayload;
}

let nextToken = 1;

/** A message's text parts, as core freezes them into a one-message share. */
function textOf(content: string): string {
  try {
    const parts: unknown = JSON.parse(content);
    if (!Array.isArray(parts)) return content.trim();
    return parts
      .filter(
        (part): part is { type: "text"; content: string } =>
          part?.type === "text" && typeof part.content === "string" && !!part.content.trim(),
      )
      .map((part) => part.content)
      .join("\n\n")
      .trim();
  } catch {
    return content.trim();
  }
}

export function shareHandlers(sessions: ChatSession[], transcripts: Record<string, ChatMessage[]>) {
  const shares = new Map<string, MockShare>();
  const summary = (share: MockShare) => ({
    id: share.payload.id,
    title: share.payload.title,
    url: `/share/${share.payload.id}`,
    createdAt: share.createdAt,
  });
  const save = (sessionId: string, title: string, messages: ChatMessage[], messageId?: string) => {
    const id = `mock-share-${nextToken++}`;
    const payload: SharedChatPayload = {
      id,
      title,
      snapshot: { mainSessionId: sessionId, messages, traces: {} },
      layout: [],
    };
    const share = { sessionId, messageId, createdAt: new Date().toISOString(), payload };
    shares.set(id, share);
    return HttpResponse.json(summary(share), { status: 201 });
  };
  // A message's one live link, as core finds it by the message its snapshot froze.
  const messageShare = (sessionId: string, messageId: string) =>
    [...shares.values()].find(
      (share) => share.sessionId === sessionId && share.messageId === messageId,
    );

  return [
    http.post("/api/chat/sessions/:id/share", async ({ params, request }) => {
      const sessionId = String(params.id);
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return HttpResponse.json({ error: "Session not found" }, { status: 404 });
      if (sessionId === CONCIERGE_CHAT_ID || session.agentName === CONCIERGE_AGENT_ID) {
        return HttpResponse.json(
          { error: "A Concierge chat cannot be shared. Share one message instead." },
          { status: 403 },
        );
      }
      const body = (await request.json().catch(() => ({}))) as { turnIds?: string[] };
      const turnIds = new Set(body.turnIds ?? []);
      const messages = (transcripts[sessionId] ?? []).filter(
        (m) => m.turnId && turnIds.has(m.turnId),
      );
      if (messages.length === 0) {
        return HttpResponse.json(
          { error: "No messages match the selected turns" },
          { status: 400 },
        );
      }
      return save(sessionId, session.name, messages);
    }),
    http.get("/api/chat/sessions/:id/messages/:messageId/share", ({ params }) => {
      const share = messageShare(String(params.id), String(params.messageId));
      return HttpResponse.json({ share: share ? summary(share) : null });
    }),
    http.post("/api/chat/sessions/:id/messages/:messageId/share", ({ params }) => {
      const sessionId = String(params.id);
      const existing = messageShare(sessionId, String(params.messageId));
      if (existing) return HttpResponse.json(summary(existing));
      const message = (transcripts[sessionId] ?? []).find((m) => m.id === params.messageId);
      if (!message || (message.role !== "user" && message.role !== "assistant")) {
        return HttpResponse.json({ error: "Message not found" }, { status: 404 });
      }
      const text = textOf(message.content);
      if (!text) {
        return HttpResponse.json({ error: "The message has no text to share" }, { status: 400 });
      }
      const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
      const title = firstLine
        .replace(/^[\s#>*-]+/, "")
        .replace(/\*\*|__|`/g, "")
        .trim()
        .slice(0, 120);
      const frozen: ChatMessage = {
        id: message.id,
        sessionId: message.sessionId,
        turnId: message.turnId,
        role: message.role,
        content: JSON.stringify([{ type: "text", content: text }]),
        createdAt: message.createdAt,
      };
      return save(sessionId, title, [frozen], message.id);
    }),
    http.get("/api/chat/sessions/:id/shares", ({ params }) =>
      HttpResponse.json(
        [...shares.values()]
          .filter((share) => share.sessionId === params.id)
          .reverse()
          .map(summary),
      ),
    ),
    http.delete("/api/chat/shares/:shareId", ({ params }) =>
      shares.delete(String(params.shareId))
        ? HttpResponse.json({ ok: true })
        : HttpResponse.json({ error: "Share not found" }, { status: 404 }),
    ),
    http.get("/api/share/:token", ({ params }) => {
      const share = shares.get(String(params.token));
      return share
        ? HttpResponse.json(share.payload)
        : HttpResponse.json({ error: "Share not found" }, { status: 404 });
    }),
  ];
}
