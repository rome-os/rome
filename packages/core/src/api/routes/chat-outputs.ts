import { stat } from "node:fs/promises";
import type { ChatOutputSource, ChatOutputsResponse } from "@rome/api-types/chat-outputs";
import { Hono } from "hono";
import { ChatOutputs } from "../../chats/outputs/chat-outputs.js";
import { ChatOutputsRepository } from "../../chats/outputs/repository.js";
import { createStreamResponse, describeFile } from "../../lib/file-browser-server.js";
import { ownerOf } from "../../webchat/owner.js";
import { isConciergeChat } from "../../webchat/privacy.js";
import type { ApiDeps } from "../deps.js";

type ChatOutputsApiDeps = Pick<ApiDeps, "db" | "concierge" | "webchatRepo">;

// Only these open in the browser. Same-origin with the dashboard, so html,
// xml, js and anything unknown download instead of running.
const INLINE_KINDS = new Set(["image", "video", "audio", "pdf"]);
const CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

/**
 * A chat's outputs, the files its agent wrote or showed, and each one's bytes.
 * Mount behind the webchat routes' private chat gate, which answers for
 * `/chat/sessions/:id/*`: another owner's Concierge or task chat is not found.
 * docs/domains/chats.md#outputs
 */
export function chatOutputsRoutes(deps: ChatOutputsApiDeps): Hono {
  const app = new Hono();
  const outputs = new ChatOutputs({
    repo: new ChatOutputsRepository(deps.db),
    chat: (id) => deps.webchatRepo.getSession(id),
    messages: (id) => deps.webchatRepo.getMessages(id),
  });

  /** The chat, and the task chats it started when it is a Concierge chat; null when it is gone. */
  const chatOf = async (chatId: string): Promise<{ taskChats: ChatOutputSource[] } | null> => {
    const chat = await deps.webchatRepo.getSession(chatId);
    if (!chat) return null;
    const tasks = isConciergeChat(chat) ? deps.concierge?.deps.tasks.repo : undefined;
    return { taskChats: (await tasks?.taskChatsStartedBy(chat.id, ownerOf(chat))) ?? [] };
  };

  app.get("/chat/sessions/:id/outputs", async (c) => {
    const chatId = c.req.param("id");
    const chat = await chatOf(chatId);
    if (!chat) return c.json({ error: "Session not found" }, 404);
    return c.json({
      outputs: await outputs.list(chatId, chat.taskChats),
    } satisfies ChatOutputsResponse);
  });

  app.get("/chat/sessions/:id/outputs/:outputId/content", async (c) => {
    const chatId = c.req.param("id");
    const notFound = () => c.json({ error: "Not found" }, 404);
    const chat = await chatOf(chatId);
    if (!chat) return notFound();
    const file = await outputs.file(chatId, c.req.param("outputId"), chat.taskChats);
    if (!file) return notFound();
    let size: number;
    try {
      size = (await stat(file.path)).size;
    } catch {
      return notFound();
    }
    const described = describeFile(file.path);
    const inline = INLINE_KINDS.has(described.kind);
    return createStreamResponse(file.path, 200, {
      "Cache-Control": "private, no-cache",
      "Content-Security-Policy": described.kind === "pdf" ? CSP : `${CSP}; sandbox`,
      "Content-Disposition": inline ? "inline" : "attachment",
      "Content-Length": String(size),
      "Content-Type": described.mimeType,
      "X-Content-Type-Options": "nosniff",
    });
  });

  return app;
}
