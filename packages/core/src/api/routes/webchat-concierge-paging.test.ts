import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createWebchatRuntime } from "./webchat.js";
import { ConciergeTasks } from "../../concierge/tasks.js";
import { ConciergeTasksRepository } from "../../db/repositories/concierge-tasks.js";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";

// `?type=concierge` pages a Concierge chat by its main-line messages, each
// with the whole thread it roots (docs/domains/chats.md#chat-thread).

interface WireMessage {
  id: string;
  role: string;
  chatThreadId?: string | null;
}

interface WirePage {
  type: string;
  traces: WireMessage[];
  mainLine: {
    message: WireMessage;
    thread: {
      replyCount: number;
      unreadCount: number;
      lastReplyAt: string;
      replies: WireMessage[];
    } | null;
  }[];
  outside: {
    root: string;
    title: string | null;
    replyCount: number;
    unreadCount: number;
    latestUnread: WireMessage;
  }[];
  nextCursor: string | null;
  hasMore: boolean;
  layout?: unknown;
}

const CHAT = "topic";
const BASE_SECONDS = Math.floor(Date.now() / 1000) - 3600;
const text = (content: string) => JSON.stringify([{ type: "text", content }]);

describe("GET /chat/sessions/:id/messages?type=concierge", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: ReturnType<typeof createWebchatRuntime>["routes"];

  /** Moves the message keyed `key` to `seconds`, and the session back with it. */
  const setSaidAt = (key: string, seconds: number) => {
    testDb.db.run(sql`UPDATE chat_messages SET said_at = ${seconds} WHERE key = ${key}`);
    testDb.db.run(sql`UPDATE rome_sessions SET created_at = min(created_at, ${seconds})
      WHERE id = ${CHAT}`);
  };
  const user = async (key: string, seconds: number, replyTo?: string, automated?: string) => {
    await deps.webchatRepo.recordUserInput(
      key,
      CHAT,
      text(`words of ${key}`),
      undefined,
      automated ? { platform: "webchat", id: automated } : undefined,
      replyTo,
    );
    setSaidAt(key, seconds);
    return key;
  };
  const assistant = async (seconds: number, replyTo?: string) => {
    const { id } = await deps.webchatRepo.addBackendMessage(
      CHAT,
      "turn-1",
      [{ type: "text", content: "an answer" }],
      replyTo ? { replyTo } : {},
    );
    setSaidAt(id, seconds);
    return id;
  };

  /**
   * Ten main-line messages m1..m10 said ten seconds apart, then replies:
   * to m5 an unread answer and a later one, and the owner's reply to the first;
   * to m2 an unread answer and an automation's. Every reply is said after m10.
   */
  async function seedChat() {
    const main: string[] = [];
    for (let i = 1; i <= 10; i += 1) main.push(await user(`m${i}`, BASE_SECONDS + i * 10));
    const r5 = await assistant(BASE_SECONDS + 210, "m5");
    const r5own = await user("r5own", BASE_SECONDS + 220, r5);
    const r5late = await assistant(BASE_SECONDS + 230, "m5");
    const r2 = await assistant(BASE_SECONDS + 200, "m2");
    const r2auto = await user("r2auto", BASE_SECONDS + 205, "m2", "automated::0::routine:Daily");
    return { main, r5, r5own, r5late, r2, r2auto };
  }

  async function request(query: string) {
    return app.request(`/chat/sessions/${CHAT}/messages${query}`);
  }
  async function getPage(query: string): Promise<WirePage> {
    const res = await request(query);
    expect(res.status).toBe(200);
    return (await res.json()) as WirePage;
  }
  const ids = (page: WirePage) => page.mainLine.map((entry) => entry.message.id);

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    await seedBaseline(testDb.db);
    await deps.webchatRepo.createSession(
      CHAT,
      "Topic",
      undefined,
      undefined,
      null,
      undefined,
      "core:concierge",
    );
    app = createWebchatRuntime(deps).routes;
  });

  afterEach(() => {
    rs.restoreAllMocks();
    testDb.close();
  });

  it("pages by main-line messages, so a reply never counts, and brings each thread whole", async () => {
    const seeded = await seedChat();

    const first = await getPage("?type=concierge&limit=3");
    expect(first.type).toBe("concierge");
    expect(ids(first)).toEqual(["m8", "m9", "m10"]);
    expect(first.mainLine.every((entry) => entry.thread === null)).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await getPage(
      `?type=concierge&limit=3&before=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(ids(second)).toEqual(["m5", "m6", "m7"]);
    const [m5] = second.mainLine;
    // Every reply whose root it is, deeper ones too, in the order they were said.
    expect(m5?.thread?.replies.map((reply) => reply.id)).toEqual([
      seeded.r5,
      "r5own",
      seeded.r5late,
    ]);
    expect(m5?.thread).toMatchObject({ replyCount: 3, unreadCount: 2 });
    expect(m5?.thread?.lastReplyAt).toBe(new Date((BASE_SECONDS + 230) * 1000).toISOString());
    expect(m5?.thread?.replies.every((reply) => reply.chatThreadId === "m5")).toBe(true);

    const third = await getPage(
      `?type=concierge&limit=3&before=${encodeURIComponent(second.nextCursor ?? "")}`,
    );
    expect(ids(third)).toEqual(["m2", "m3", "m4"]);
    // An automation's reply is in the thread and is not counted.
    expect(third.mainLine[0]?.thread?.replies.map((reply) => reply.id)).toEqual([
      seeded.r2,
      seeded.r2auto,
    ]);
    expect(third.mainLine[0]?.thread).toMatchObject({ replyCount: 1, unreadCount: 1 });

    const last = await getPage(
      `?type=concierge&limit=3&before=${encodeURIComponent(third.nextCursor ?? "")}`,
    );
    expect(ids(last)).toEqual(["m1"]);
    expect(last.nextCursor).toBeNull();
    expect(last.hasMore).toBe(false);
  });

  it("holds forty main-line messages when no limit is given", async () => {
    for (let i = 1; i <= 45; i += 1) await user(`n${i}`, BASE_SECONDS + i);

    const page = await getPage("?type=concierge");

    expect(page.mainLine).toHaveLength(40);
    expect(ids(page)[0]).toBe("n6");
    expect(page.hasMore).toBe(true);
  });

  it("names the threads with unread replies whose root is older, on the newest page only, one each", async () => {
    const seeded = await seedChat();

    const first = await getPage("?type=concierge&limit=3");
    // Oldest waiting first: m2's answer was said before m5's.
    expect(first.outside.map((entry) => entry.root)).toEqual(["m2", "m5"]);
    expect(first.outside[0]).toMatchObject({
      root: "m2",
      replyCount: 1,
      unreadCount: 1,
      title: null,
    });
    expect(first.outside[0]?.latestUnread.id).toBe(seeded.r2);
    expect(first.outside[1]).toMatchObject({ root: "m5", replyCount: 3, unreadCount: 2 });
    // Only the newest unread reply, and it is not also among the main line.
    expect(first.outside[1]?.latestUnread.id).toBe(seeded.r5late);

    const older = await getPage(
      `?type=concierge&limit=3&before=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(older.outside).toEqual([]);

    // A thread whose root is on the page waits in its stack, not outside.
    const wide = await getPage("?type=concierge&limit=100");
    expect(wide.outside).toEqual([]);
  });

  it("names an outside thread by its task", async () => {
    await seedChat();
    const repo = new ConciergeTasksRepository(testDb.db);
    deps.concierge = {
      deps: { tasks: new ConciergeTasks(repo) },
      onCardSettled: () => () => {},
    } as never;
    await repo.upsertMany(
      [{ title: "Plan the trip", state: "doing", chatId: CHAT, sourceMessageId: "m2" }],
      new Date(1_000),
    );
    app = createWebchatRuntime(deps).routes;

    const page = await getPage("?type=concierge&limit=3");

    expect(page.outside.find((entry) => entry.root === "m2")?.title).toBe("Plan the trip");
  });

  it("reads through a reply to its thread's root, with two older messages of context", async () => {
    const seeded = await seedChat();

    // The root of m5's thread is m5; m5..m10 are six messages and two older come with them.
    const page = await getPage(`?type=concierge&limit=2&through=${seeded.r5own}`);

    expect(ids(page)).toEqual(["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.hasMore).toBe(true);
    // The main-line key reaches itself the same way.
    expect(ids(await getPage("?type=concierge&limit=2&through=m5"))).toEqual(ids(page));

    // Combined with `before`, it reaches down from that cursor.
    const first = await getPage("?type=concierge&limit=3");
    const below = await getPage(
      `?type=concierge&limit=1&through=m5&before=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(ids(below)).toEqual(["m3", "m4", "m5", "m6", "m7"]);

    // A message the chat does not hold changes nothing.
    expect(ids(await getPage("?type=concierge&limit=2&through=missing"))).toEqual(["m9", "m10"]);
  });

  it("reads a whole thread by any message of it, in the same shape", async () => {
    const seeded = await seedChat();

    for (const key of ["m5", seeded.r5, seeded.r5own]) {
      const page = await getPage(`?type=concierge&thread=${key}`);
      expect(page).toMatchObject({
        type: "concierge",
        outside: [],
        nextCursor: null,
        hasMore: false,
      });
      expect(ids(page)).toEqual(["m5"]);
      expect(page.mainLine[0]?.thread?.replies.map((reply) => reply.id)).toEqual([
        seeded.r5,
        "r5own",
        seeded.r5late,
      ]);
    }
    expect((await getPage("?type=concierge&thread=nope")).mainLine).toEqual([]);
  });

  it("refuses what it cannot read", async () => {
    await seedChat();
    const first = await getPage("?type=concierge&limit=3");
    const turnCursor = ((await (await request("?limit=1")).json()) as { nextCursor: string })
      .nextCursor;

    const refused = async (query: string, error: string) => {
      const res = await request(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining(error) });
    };
    await refused("?type=other", 'type must be "concierge"');
    await refused("?type=concierge&limit=0", "limit must be an integer from 1 to 100");
    await refused("?type=concierge&limit=101", "limit must be an integer from 1 to 100");
    await refused("?type=concierge&limit=x", "limit must be an integer from 1 to 100");
    await refused("?type=concierge&before=garbage", "Invalid before cursor");
    // A turn cursor and a Concierge cursor are not each other's.
    await refused(
      `?type=concierge&before=${encodeURIComponent(turnCursor)}`,
      "Invalid before cursor",
    );
    await refused(
      `?limit=1&before=${encodeURIComponent(first.nextCursor ?? "")}`,
      "Invalid before cursor",
    );
    await refused("?type=concierge&through=", "through must name a message");
    await refused("?type=concierge&thread=", "thread must name a message");
    for (const extra of ["limit=3", "through=m5", `before=${first.nextCursor}`]) {
      await refused(`?type=concierge&thread=m5&${extra}`, "thread cannot come with");
    }
  });

  it("says a chat that is not a Concierge chat is not one", async () => {
    await deps.webchatRepo.createSession("plain", "Plain");

    const res = await app.request("/chat/sessions/plain/messages?type=concierge");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "not_concierge" });
  });

  it("answers 404 for a chat it does not hold", async () => {
    const res = await app.request("/chat/sessions/missing/messages?type=concierge");

    expect(res.status).toBe(404);
  });

  it("reads nothing as read, and leaves the paging without a type as it was", async () => {
    await seedChat();

    await getPage("?type=concierge&limit=100");

    const unread = testDb.db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM chat_messages WHERE read_at IS NULL AND root_message_id IS NOT NULL
        AND sender_agent IS NOT NULL`,
    );
    expect(unread[0]?.n).toBe(3);
    const plain = (await (await request("?limit=2")).json()) as {
      messages: WireMessage[];
      nextCursor: string | null;
    };
    expect(plain).not.toHaveProperty("type");
    expect(plain.messages.length).toBeGreaterThan(0);
    expect(plain.nextCursor).toEqual(expect.any(String));
  });

  it("carries the saved layout on the first page only", async () => {
    await seedChat();
    const layout = [{ id: "w1", type: "projects", order: 1 }];
    await deps.webchatRepo.saveLayout(CHAT, layout);

    const first = await getPage("?type=concierge&limit=3");
    expect(first.layout).toEqual(layout);
    const older = await getPage(
      `?type=concierge&limit=3&before=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect("layout" in older).toBe(false);
  });
  it("counts an unread reply the same way on the page and outside it", async () => {
    const seeded = await seedChat();
    await deps.webchatRepo.markMessagesRead(CHAT, [seeded.r5]);

    const outside = await getPage("?type=concierge&limit=3");
    const wide = await getPage("?type=concierge&limit=100");

    expect(outside.outside.find((entry) => entry.root === "m5")).toMatchObject({
      replyCount: 3,
      unreadCount: 1,
    });
    expect(wide.mainLine.find((entry) => entry.message.id === "m5")?.thread).toMatchObject({
      replyCount: 3,
      unreadCount: 1,
    });
    // An automation's reply is counted by neither.
    expect(outside.outside.find((entry) => entry.root === "m2")?.replyCount).toBe(1);
    expect(wide.mainLine.find((entry) => entry.message.id === "m2")?.thread?.replyCount).toBe(1);
  });

  describe("trace rows", () => {
    /** Four turns, each a prompt and its trace, said ten seconds apart. */
    async function seedTurns() {
      for (let i = 1; i <= 4; i += 1) {
        const turnId = `turn-${i}`;
        await deps.webchatRepo.addMessage(`p${i}`, CHAT, "user", text(`prompt ${i}`), turnId);
        await deps.webchatRepo.appendTraceBlocks({
          messageId: `trace-${i}`,
          sessionId: CHAT,
          turnId,
          startSeq: 0,
          blocks: [{ type: "turn_end", turnId, status: "completed", durationMs: 1000 + i }],
        });
        setSaidAt(`p${i}`, BASE_SECONDS + i * 10);
        testDb.db.run(sql`UPDATE rome_agent_messages SET created_at = ${BASE_SECONDS + i * 10 + 1}
          WHERE id = ${`trace-${i}`}`);
      }
    }

    it("brings back the traces of the turns on the page, and no other", async () => {
      await seedTurns();

      const first = await getPage("?type=concierge&limit=2");
      expect(ids(first)).toEqual(["p3", "p4"]);
      expect(first.traces.map((trace) => trace.id)).toEqual(["trace-3", "trace-4"]);
      expect(first.traces.every((trace) => trace.role === "trace")).toBe(true);
      // The trace carries what the client reads of the turn.
      expect(first.traces[0]).toHaveProperty("traceSummary");

      const older = await getPage(
        `?type=concierge&limit=2&before=${encodeURIComponent(first.nextCursor ?? "")}`,
      );
      expect(older.traces.map((trace) => trace.id)).toEqual(["trace-1", "trace-2"]);
    });

    it("brings the traces of a thread's turns in thread mode", async () => {
      await seedTurns();

      const page = await getPage("?type=concierge&thread=p2");

      expect(page.traces.map((trace) => trace.id)).toEqual(["trace-2"]);
    });

    it("has no traces for a page whose turns have none", async () => {
      await seedChat();

      expect((await getPage("?type=concierge&limit=100")).traces).toEqual([]);
    });
  });
});
