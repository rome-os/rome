import { http, HttpResponse } from "msw";
import type { ChatMessage, ChatSession } from "@/lib/chat-types";
import type { SharedChatPayload } from "@/lib/chat-api";

// Share links, held in memory: a chat's selected turns, frozen at share time
// and read back on `/share/:token`. Mirrors `/chat/sessions/:id/share`, the
// listing and the revoke in packages/core/src/api/routes/webchat.ts, and the
// public read in share.ts.

interface MockShare {
  sessionId: string;
  createdAt: string;
  payload: SharedChatPayload;
}

let nextToken = 1;

export function shareHandlers(sessions: ChatSession[], transcripts: Record<string, ChatMessage[]>) {
  const shares = new Map<string, MockShare>();
  const save = (
    sessionId: string,
    title: string,
    messages: ChatMessage[],
    agentName: string | undefined,
  ) => {
    const id = `mock-share-${nextToken++}`;
    const payload: SharedChatPayload = {
      id,
      title,
      snapshot: { mainSessionId: sessionId, messages, traces: {}, agentName },
      layout: [],
    };
    shares.set(id, { sessionId, createdAt: new Date().toISOString(), payload });
    return HttpResponse.json({ id, url: `/share/${id}`, title }, { status: 201 });
  };

  return [
    http.post("/api/chat/sessions/:id/share", async ({ params, request }) => {
      const sessionId = String(params.id);
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return HttpResponse.json({ error: "Session not found" }, { status: 404 });
      const body = (await request.json().catch(() => ({}))) as {
        turnIds?: string[];
        agentName?: string;
      };
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
      return save(sessionId, session.name, messages, body.agentName?.trim() || undefined);
    }),
    http.get("/api/chat/sessions/:id/shares", ({ params }) =>
      HttpResponse.json(
        [...shares.values()]
          .filter((share) => share.sessionId === params.id)
          .reverse()
          .map((share) => ({
            id: share.payload.id,
            title: share.payload.title,
            url: `/share/${share.payload.id}`,
            createdAt: share.createdAt,
          })),
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
