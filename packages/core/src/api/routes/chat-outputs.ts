import { Readable } from "node:stream";
import type { ChatOutputSource, ChatOutputsResponse } from "@rome/api-types/chat-outputs";
import { Hono } from "hono";
import { ChatOutputs } from "../../chats/outputs/chat-outputs.js";
import { ChatOutputsRepository } from "../../chats/outputs/repository.js";
import { describeFile } from "../../lib/file-browser-server.js";
import { resolveWebchatProjectPath } from "../../webchat/projects.js";
import { ownerOf } from "../../webchat/owner.js";
import { isConciergeChat } from "../../webchat/privacy.js";
import type { ApiDeps } from "../deps.js";

type ChatOutputsApiDeps = Pick<ApiDeps, "db" | "concierge" | "webchatRepo">;

// Only these open in the browser. Same-origin with the dashboard, so html,
// xml, js and anything unknown download instead of running.
const INLINE_KINDS = new Set(["image", "video", "audio", "pdf"]);
const CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

/** The absolute folder of a chat's project, or null when it names none Rome can place. */
function projectDirOf(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null;
  try {
    return resolveWebchatProjectPath(projectPath);
  } catch {
    return null;
  }
}

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
    chat: async (id) => {
      const chat = await deps.webchatRepo.getSession(id);
      return chat ? { id: chat.id, projectDir: projectDirOf(chat.projectPath) } : null;
    },
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
    const { outputs: list, indexing } = await outputs.list(chatId, chat.taskChats);
    return c.json({ outputs: list, indexing } satisfies ChatOutputsResponse);
  });

  app.get("/chat/sessions/:id/outputs/:outputId/content", async (c) => {
    const chatId = c.req.param("id");
    const notFound = () => c.json({ error: "Not found" }, 404);
    const chat = await chatOf(chatId);
    if (!chat) return notFound();
    const file = await outputs.open(chatId, c.req.param("outputId"), chat.taskChats);
    if (!file) return notFound();
    const described = describeFile(file.path);
    const inline = INLINE_KINDS.has(described.kind);
    // Streams the descriptor that was checked, never the path opened again,
    // and only the bytes fstat counted.
    let body: ReadableStream | null = null;
    if (file.size === 0) await file.handle.close();
    else {
      body = Readable.toWeb(
        file.handle.createReadStream({ start: 0, end: file.size - 1 }),
      ) as ReadableStream;
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-cache",
        "Content-Security-Policy": described.kind === "pdf" ? CSP : `${CSP}; sandbox`,
        "Content-Disposition": inline ? "inline" : "attachment",
        "Content-Length": String(file.size),
        "Content-Type": described.mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  return app;
}
