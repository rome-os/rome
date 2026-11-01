import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps, ChatLine, ChatRepository } from "@rome-os/app-runtime";
import { WebChatRepository } from "../../../../../packages/core/src/db/repositories/webchat.js";
import type { SessionActor } from "../../../../../packages/core/src/lib/session-actor.js";
import {
  createTestDb,
  testAppRepositories,
  type TestDb,
} from "../../../../../packages/core/src/test/helpers.js";
import { seatFixture } from "../../../../../packages/core/src/test/seats.js";
import { createAction } from "./index.js";

const actionConfig = {
  name: "get_webchat_conversations",
  type: "custom",
  description: "Fetch recent webchat conversations",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as const;

/** Ten minutes ago, inside every window the tests ask for. */
const NOW = Math.floor(Date.now() / 1000) - 600;

interface Row {
  session_id: string;
  session_name: string;
  role: string;
  content: string;
  created_at: number;
}

/** An action over a chat repository holding `rows`, one per line of a
 *  guardian's dashboard chat. */
function makeDeps(rows: Row[]): AppActionRuntimeDeps {
  const sessions = [...new Set(rows.map((row) => row.session_id))];
  const chats = {
    recentChats: async () =>
      sessions.map((sessionId) => ({
        sessionId,
        name: rows.find((row) => row.session_id === sessionId)!.session_name,
        ownerKey: "guardian",
        archived: false,
      })),
    transcript: async (sessionId: string): Promise<ChatLine[]> =>
      rows
        .filter((row) => row.session_id === sessionId)
        .map((row, i) => ({
          id: `${sessionId}-${i}`,
          turnId: null,
          role: row.role as ChatLine["role"],
          senderId: row.role === "user" ? "guardian" : null,
          senderName: null,
          content: row.content,
          createdAt: new Date(row.created_at * 1000),
        })),
  } as unknown as ChatRepository;
  return { appContext: { repositories: { chats } } } as unknown as AppActionRuntimeDeps;
}

describe("get_webchat_conversations", () => {
  it("returns formatted conversations grouped by session", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat A",
        role: "user",
        content: "hello",
        created_at: NOW,
      },
      {
        session_id: "s1",
        session_name: "Chat A",
        role: "assistant",
        content: "hi there",
        created_at: NOW + 10,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { messageCount: number; content: string };
    expect(data.messageCount).toBe(2);
    expect(data.content).toContain("### Conversation: Chat A");
    expect(data.content).toContain("**Guardian**: hello");
    expect(data.content).toContain("**Agent**: hi there");
  });

  it("returns empty message when no rows found", async () => {
    const action = createAction(actionConfig, makeDeps([]));
    const result = await action.execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("(No webchat conversations found in the requested window.)");
  });

  it("extracts text from JSON content blocks", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Here is the answer" },
          { type: "tool_use", id: "t1", name: "search", input: {} },
        ]),
        created_at: NOW,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("Here is the answer");
    expect(data.content).not.toContain("tool_use");
  });

  it("extracts plain string JSON content", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "user",
        content: JSON.stringify("a plain string"),
        created_at: NOW,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("a plain string");
  });

  it("handles non-JSON raw content gracefully", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "user",
        content: "just plain text",
        created_at: NOW,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("just plain text");
  });

  it("filters tool_result blocks from content", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_result", content: "internal stuff" },
          { type: "text", text: "visible answer" },
        ]),
        created_at: NOW,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("visible answer");
    expect(data.content).not.toContain("internal stuff");
  });

  it("separates multiple sessions with dividers", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat A",
        role: "user",
        content: "msg1",
        created_at: NOW,
      },
      {
        session_id: "s2",
        session_name: "Chat B",
        role: "user",
        content: "msg2",
        created_at: NOW + 10,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("### Conversation: Chat A");
    expect(data.content).toContain("### Conversation: Chat B");
    expect(data.content).toContain("---");
  });

  it("returns error when DB query fails", async () => {
    const chats = {
      recentChats: async () => {
        throw new Error("db locked");
      },
    } as unknown as ChatRepository;
    const deps = { appContext: { repositories: { chats } } } as unknown as AppActionRuntimeDeps;

    const action = createAction(actionConfig, deps);
    const result = await action.execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("db locked");
  });

  it("returns no-readable-messages when all content is empty", async () => {
    const rows = [
      {
        session_id: "s1",
        session_name: "Chat",
        role: "assistant",
        content: JSON.stringify([{ type: "tool_use", id: "t1", name: "x", input: {} }]),
        created_at: NOW,
      },
    ];

    const action = createAction(actionConfig, makeDeps(rows));
    const result = await action.execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("(No readable messages found.)");
  });
});

describe("get_webchat_conversations against the system schema", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  function realDeps(): AppActionRuntimeDeps {
    return {
      appContext: { repositories: testAppRepositories(testDb.db) },
    } as unknown as AppActionRuntimeDeps;
  }

  /** A session of `type`: a dashboard chat for `webchat`, a handoff chat in
   *  the dashboard for `webchat_handoff`, a Telegram group Rome's account is
   *  in for `channel`, and a background session in no chat otherwise. */
  async function seedSession(id: string, name: string, type: string, createdAt: number) {
    const repo = new WebChatRepository(testDb.db);
    if (type === "webchat" || type === "webchat_handoff") {
      await repo.createSession(id, name);
      if (type === "webchat_handoff") {
        testDb.db.run(sql`UPDATE rome_sessions SET type = 'webchat_handoff' WHERE id = ${id}`);
      }
    } else if (type === "channel") {
      const fixture = seatFixture(testDb.db);
      const chat = fixture.chat("telegram", `telegram:${id}`, "group");
      fixture.seat({ id, chat, accountId: "telegram-bot", name });
    } else {
      await repo.ensureRomeSession({ id, name, type: type as "action", agentName: null });
    }
    testDb.db.run(sql`UPDATE rome_sessions SET created_at = ${createdAt} WHERE id = ${id}`);
  }

  /** A line of `role` said in session `sessionId` at `createdAt`, by `actor`
   *  when a person said it (the guardian when absent). */
  async function seedMessage(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    createdAt: number,
    actor?: SessionActor,
  ) {
    const repo = new WebChatRepository(testDb.db);
    const seat = testDb.db.get<{ platform: string; chat_id: string } | undefined>(sql`
      SELECT c.platform, c.id AS chat_id FROM rome_sessions s JOIN chats c ON c.id = s.chat_id
      WHERE s.id = ${sessionId}
    `);
    if (seat && seat.platform !== "webchat") {
      seatFixture(testDb.db).say({
        id,
        chat: { platform: seat.platform, id: seat.chat_id },
        from: "person",
        parts: JSON.parse(content),
        at: new Date(createdAt * 1000),
      });
      return;
    }
    if (role === "user" && seat) await repo.recordUserInput(id, sessionId, content, actor);
    else await repo.addMessage(id, sessionId, role, content, `turn-${id}`);
    testDb.db.run(sql`UPDATE chat_messages SET said_at = ${createdAt} WHERE id = ${id}`);
    testDb.db.run(sql`UPDATE rome_agent_messages SET created_at = ${createdAt} WHERE id = ${id}`);
  }

  // The shape core persists: text parts carry their text in `content`.
  const text = (value: string) => JSON.stringify([{ type: "text", content: value }]);

  it("reads webchat and handoff conversations, not channels or background runs", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedSession("web", "Web chat", "webchat", now - 60);
    await seedSession("handoff", "Handoff chat", "webchat_handoff", now - 60);
    await seedSession("group", "Group chat", "channel", now - 60);
    await seedSession("bg", "Dream run", "action", now - 60);
    await seedMessage("m1", "web", "user", text("web question"), now - 50);
    await seedMessage("m2", "web", "trace", "[]", now - 45);
    await seedMessage(
      "m4",
      "web",
      "assistant",
      JSON.stringify([{ type: "text", content: "web answer", turnPhase: "final" }]),
      now - 40,
    );
    await seedMessage("m5", "handoff", "user", text("handoff question"), now - 35);
    await seedMessage("m6", "group", "user", text("group member message"), now - 30);
    await seedMessage("m7", "bg", "user", text("dream prompt"), now - 20);

    const result = await createAction(actionConfig, realDeps()).execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { messageCount: number; content: string };
    // The trace is the agent's own row, not a line of the chat.
    expect(data.messageCount).toBe(3);
    expect(data.content).toContain("### Conversation: Web chat");
    expect(data.content).toContain("**Guardian**: web question");
    expect(data.content).toContain("**Agent**: web answer");
    expect(data.content).toContain("### Conversation: Handoff chat");
    expect(data.content).toContain("**Guardian**: handoff question");
    expect(data.content).not.toContain("group member message");
    expect(data.content).not.toContain("dream prompt");
  });

  it("leaves out chats a visitor owns or wrote in", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedSession("mine", "Mine", "webchat", now - 60);
    await seedSession("shared", "Shared", "webchat", now - 60);
    await seedSession("theirs", "Theirs", "webchat", now - 60);
    testDb.db.run(sql`UPDATE rome_sessions SET owner_key = 'visitor:acc' WHERE id = 'theirs'`);
    await seedMessage("m1", "mine", "user", text("guardian request"), now - 50);
    await seedMessage("m2", "shared", "user", text("guardian start"), now - 50);
    await seedMessage("m3", "shared", "user", text("visitor request"), now - 40, {
      kind: "visitor",
      accountId: "acc",
      email: "v@example.com",
    });
    await seedMessage("m4", "theirs", "user", text("owner request"), now - 50);

    const all = await createAction(actionConfig, realDeps()).execute({ windowHours: 1 });
    const one = await createAction(actionConfig, realDeps()).execute({ sessionId: "shared" });

    const content = (all as { data: { content: string } }).data.content;
    expect(content).toContain("guardian request");
    expect(content).not.toContain("guardian start");
    expect(content).not.toContain("visitor request");
    expect(content).not.toContain("owner request");
    expect((one as { data: { messageCount: number } }).data.messageCount).toBe(0);
  });

  it("scopes to one session", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedSession("a", "Chat A", "webchat", now - 60);
    await seedSession("b", "Chat B", "webchat", now - 60);
    await seedMessage("m1", "a", "user", text("from a"), now - 50);
    await seedMessage("m2", "b", "user", text("from b"), now - 50);

    const result = await createAction(actionConfig, realDeps()).execute({ sessionId: "a" });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("from a");
    expect(data.content).not.toContain("from b");
  });
});
