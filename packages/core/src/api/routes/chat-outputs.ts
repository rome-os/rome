import { Readable } from "node:stream";
import type { ChatOutputSource, ChatOutputsResponse } from "@rome/api-types/chat-outputs";
import { Hono } from "hono";
import { ChatOutputs } from "../../chats/outputs/chat-outputs.js";
import { ChatOutputsRepository } from "../../chats/outputs/repository.js";
import { describeFile, parseRangeHeader } from "../../lib/file-browser-server.js";
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
 * Mount behind the webchat routes' chat gate, which answers for
 * `/chat/sessions/:id/*`.
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
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-cache",
      "Content-Disposition": inline ? "inline" : "attachment",
      "Content-Type": described.mimeType,
      "X-Content-Type-Options": "nosniff",
    };
    // Any policy on a PDF blanks the browser's own viewer, which the Projects
    // page's asset route also serves it to without one.
    if (described.kind !== "pdf") headers["Content-Security-Policy"] = `${CSP}; sandbox`;
    // A player asks for parts of a video or audio file as it plays and seeks.
    const rangeHeader = c.req.header("range");
    const range = rangeHeader && file.size > 0 ? parseRangeHeader(rangeHeader, file.size) : null;
    if (rangeHeader && file.size > 0 && !range) {
      await file.handle.close();
      return new Response(null, {
        status: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "Content-Range": `bytes */${file.size}`,
        },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    // Streams the descriptor that was checked, never the path opened again,
    // and only the bytes fstat counted.
    let body: ReadableStream | null = null;
    if (file.size === 0) await file.handle.close();
    else {
      body = Readable.toWeb(file.handle.createReadStream({ start, end })) as ReadableStream;
    }
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        "Content-Length": String(file.size === 0 ? 0 : end - start + 1),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.size}` } : {}),
      },
    });
  });

  return app;
}
