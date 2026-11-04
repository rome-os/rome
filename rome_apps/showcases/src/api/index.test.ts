import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import type { ChatReads, RecentChat } from "@rome-os/app-runtime/chats";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../../../../packages/core/src/test/helpers.js";
import { createApiHandler } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../db/migrations");

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
  migrate(testDb.db as never, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsTable: "__drizzle_migrations_app_showcases",
  });
});

afterEach(() => {
  testDb.close();
});

function handler(chats?: ChatReads) {
  return createApiHandler({
    ...(chats ? { repositories: { chats } } : {}),
    app: { id: "showcases", version: "0.0.0" },
    db: {
      connection: testDb.db,
      tablePrefix: "showcases",
      tableName: (name: string) => `showcases__${name}`,
    },
  } as unknown as RomeAppContext);
}

function request(method: string, path: string, body?: unknown): RomeAppApiRequest {
  return {
    method,
    path: path.split("/"),
    headers: {},
    query: new URLSearchParams(),
    body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
  } as RomeAppApiRequest;
}

const text = (value: string) => JSON.stringify([{ type: "text", content: value }]);

describe("showcases webchat sources", () => {
  it("fails to list sources when the host offers no chat reads", async () => {
    await expect(handler().handle(request("GET", "sources/sessions"))).rejects.toThrow(
      "no chat reads",
    );
  });

  const at = new Date(1700000000 * 1000);
  const dashboardChat = (sessionId: string, name: string): RecentChat => ({
    sessionId,
    chat: { platform: "webchat", id: 1 },
    name,
    threadName: null,
    ownerKey: "guardian",
    archived: false,
    channel: null,
    agentName: "helper",
    projectName: null,
    projectPath: null,
    startedAt: at,
  });
  const trace = (id: string) => ({
    id: `${id}-trace`,
    turnId: `${id}-turn`,
    content: JSON.stringify([{ type: "tool_use", id: "t1", name: "search", input: {} }]),
    createdAt: at,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
  });
  // Two dashboard chats, only "web" with a trace.
  const reads: ChatReads = {
    async recentChats() {
      return [dashboardChat("web", "Web chat"), dashboardChat("quiet", "Quiet chat")];
    },
    async transcript(sessionId) {
      if (sessionId !== "web") return [];
      const line = (role: "user" | "assistant", content: string) => ({
        key: `${sessionId}-${role}`,
        turnId: "web-turn",
        role,
        senderId: null,
        senderName: null,
        content,
        createdAt: at,
      });
      return [line("user", text("web question")), line("assistant", text("web answer"))];
    },
    async traces(sessionId) {
      return sessionId === "web" ? [trace("web")] : [];
    },
  };

  it("lists the dashboard chats without reading their traces", async () => {
    const traces = rs.spyOn(reads, "traces");
    const res = await handler(reads).handle(request("GET", "sources/sessions"));

    const { sessions } = (await res.json()) as {
      sessions: Array<{ id: string; agentName: string }>;
    };
    expect(sessions).toEqual([
      expect.objectContaining({ id: "web", agentName: "helper" }),
      expect.objectContaining({ id: "quiet" }),
    ]);
    expect(sessions[0]).not.toHaveProperty("traceCount");
    expect(traces).not.toHaveBeenCalled();
    traces.mockRestore();
  });

  it("says a listed chat with no traces has nothing to import", async () => {
    const res = await handler(reads).handle(
      request("POST", "imports/webchat-session", { sessionId: "quiet" }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ message: "No trace rows found for that session." });
  });

  it("imports a chat with its prompt, steps and reply", async () => {
    const api = handler(reads);
    const res = await api.handle(request("POST", "imports/webchat-session", { sessionId: "web" }));

    expect(res.status).toBe(200);
    const imported = (await res.json()) as { collectionId: string; traceCount: number };
    expect(imported.traceCount).toBe(1);
    const list = await api.handle(request("GET", `collections/${imported.collectionId}/traces`));
    const { traces } = (await list.json()) as {
      traces: Array<{ id: string; metadata: { userPrompt?: string } }>;
    };
    expect(traces[0]?.metadata.userPrompt).toBe("web question");
    const raw = await api.handle(request("GET", `traces/${traces[0]!.id}/raw.json`));
    const blocks = JSON.stringify(await raw.json());
    expect(blocks).toContain('"name":"search"');
    expect(blocks).toContain("web answer");
  });

  it("imports nothing from a session that is not a dashboard chat", async () => {
    const res = await handler(reads).handle(
      request("POST", "imports/webchat-session", { sessionId: "elsewhere" }),
    );

    expect(res.status).toBe(404);
  });

  it("resolves a card with the answer a later turn's line holds, said before the card", async () => {
    const second = (offset: number) => new Date(at.getTime() + offset * 1000);
    const line = (
      turnId: string,
      role: "user" | "assistant",
      content: unknown[],
      offset: number,
    ) => ({
      key: `${turnId}-${role}-${offset}`,
      turnId,
      role,
      senderId: null,
      senderName: null,
      content: JSON.stringify(content),
      createdAt: second(offset),
    });
    const card = {
      type: "pending_interaction",
      toolUseId: "item_0",
      render: { componentId: "pick", props: {} },
    };
    const answer = { type: "interaction_result", toolUseId: "item_0", output: { choice: "a" } };
    const interleaved: ChatReads = {
      ...reads,
      async transcript() {
        // The next turn's answer was said a second before this turn's card.
        return [
          line("t1", "user", [{ type: "text", content: "pick one" }], 0),
          line("t2", "user", [answer], 1),
          line("t1", "assistant", [{ type: "text", content: "choose" }, card], 2),
        ];
      },
      async traces(sessionId) {
        return sessionId === "web" ? [{ ...trace("web"), turnId: "t1" }] : [];
      },
    };
    const api = handler(interleaved);

    const res = await api.handle(request("POST", "imports/webchat-session", { sessionId: "web" }));
    const { collectionId } = (await res.json()) as { collectionId: string };
    const list = await api.handle(request("GET", `collections/${collectionId}/traces`));
    const { traces } = (await list.json()) as {
      traces: Array<{ metadata: { replyBlocks?: Array<{ type: string; result?: unknown }> } }>;
    };

    const shown = traces[0]?.metadata.replyBlocks?.find((b) => b.type === "pending_interaction");
    expect(shown?.result).toEqual({ choice: "a" });
  });
});
