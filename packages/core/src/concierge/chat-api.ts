// Concierge's client for the dashboard's own chat routes. Task chats go
// through the same HTTP pipeline a guardian's composer uses, so a task chat is
// an ordinary chat in every respect. The loopback listener resolves as the
// guardian by design (lib/guardian-session.ts).

import { getInternalApiBaseUrl } from "../internal-api-url.js";

interface ChatListEntry {
  id: string;
  name: string;
  agentName: string | null;
  triggerKind: string | null;
  running: boolean;
  awaitingGuardian: boolean;
  archivedAt: string | null;
}

interface PostedTurn {
  turnId: string;
  disposition?: "started" | "queued" | "steering";
}

export interface ChatApi {
  createChat(input: { agentName?: string; projectPath?: string }): Promise<string>;
  renameChat(chatId: string, name: string): Promise<void>;
  postTurn(chatId: string, text: string): Promise<PostedTurn>;
  listChats(): Promise<ChatListEntry[]>;
  /** Ids of the chat's turns whose streams have not ended, running or queued. */
  activeTurns(chatId: string): Promise<string[]>;
  interruptTurn(turnId: string): Promise<void>;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // A body that is not JSON carries no message.
  }
  return `HTTP ${res.status}`;
}

export function createLoopbackChatApi(
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): ChatApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const call = async <T>(path: string, init?: { method: string; body?: unknown }): Promise<T> => {
    const res = await fetchImpl(`${options.baseUrl ?? getInternalApiBaseUrl()}/api${path}`, {
      method: init?.method ?? "GET",
      ...(init?.body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }
        : {}),
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    return (await res.json()) as T;
  };
  const chatPath = (chatId: string) => `/chat/sessions/${encodeURIComponent(chatId)}`;

  return {
    async createChat(input) {
      const session = await call<{ id?: unknown }>("/chat/sessions", {
        method: "POST",
        body: {
          ...(input.agentName ? { agentName: input.agentName } : {}),
          ...(input.projectPath ? { projectPath: input.projectPath } : {}),
        },
      });
      if (typeof session.id !== "string" || !session.id) {
        throw new Error("Chat creation returned no chat id");
      }
      return session.id;
    },
    async renameChat(chatId, name) {
      await call(`${chatPath(chatId)}/name`, { method: "PATCH", body: { name } });
    },
    async postTurn(chatId, text) {
      const turn = await call<{ turnId?: unknown; disposition?: PostedTurn["disposition"] }>(
        `${chatPath(chatId)}/turns`,
        { method: "POST", body: { text } },
      );
      return {
        turnId: typeof turn.turnId === "string" ? turn.turnId : "",
        ...(turn.disposition ? { disposition: turn.disposition } : {}),
      };
    },
    async listChats() {
      return await call<ChatListEntry[]>("/chat/sessions?status=all");
    },
    async activeTurns(chatId) {
      const turns = await call<Array<{ turnId: string; agentTurnId?: string }>>(
        `${chatPath(chatId)}/turns`,
      );
      return turns.map((turn) => turn.agentTurnId ?? turn.turnId);
    },
    async interruptTurn(turnId) {
      const res = await fetchImpl(
        `${options.baseUrl ?? getInternalApiBaseUrl()}/api/chat/turns/${encodeURIComponent(turnId)}/interrupt`,
        { method: "POST" },
      );
      // 404: the turn ended before the request landed.
      if (!res.ok && res.status !== 404) throw new Error(await errorMessage(res));
    },
  };
}
