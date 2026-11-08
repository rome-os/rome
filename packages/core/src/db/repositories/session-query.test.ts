import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/db.js";
import { speakerFixture } from "../../test/speakers.js";
import { romeAgentMessages, romeSessions } from "../schema.js";
import { SessionQueryRepository } from "./session-query.js";

describe("SessionQueryRepository", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it("uses the bounded message scan and partial trace indexes for run aggregation", () => {
    const sqlite = (
      testDb.db as unknown as {
        $client: {
          prepare(sql: string): { all(...values: unknown[]): Array<{ detail: string }> };
        };
      }
    ).$client;
    const plan = sqlite
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT messages.session_id,
               json_extract(terminal.content, '$.accounting.model'),
               json_extract(turn_end.content, '$.status')
        FROM rome_agent_messages AS messages
        LEFT JOIN rome_agent_trace_blocks AS terminal
          ON terminal.message_id = messages.id
         AND json_extract(terminal.content, '$.type') IN ('result', 'error')
        LEFT JOIN rome_agent_trace_blocks AS turn_end
          ON turn_end.message_id = messages.id
         AND json_extract(turn_end.content, '$.type') = 'turn_end'
        WHERE messages.role = 'trace'
          AND messages.turn_id IS NOT NULL
          AND messages.created_at >= ?
          AND messages.created_at <= ?
      `)
      .all(0, 4_000_000_000);
    const details = plan.map((row) => row.detail).join("\n");

    expect(details).toContain("idx_rome_agent_messages_role_created_at");
    expect(details).toContain("idx_rome_agent_trace_blocks_terminal_message");
    expect(details).toContain("idx_rome_agent_trace_blocks_turn_end_message");
  });

  it("returns no aggregates when the structured scope has no allowed sessions", async () => {
    const repository = new SessionQueryRepository(testDb.db);

    await expect(
      repository.queryRunAggregates({
        from: null,
        to: new Date("2026-07-15T12:00:00.000Z"),
        sessionIds: [],
      }),
    ).resolves.toEqual([]);
  });

  describe("reading where a speaker stands", () => {
    const at = new Date(0);

    function seeded() {
      const fixture = speakerFixture(testDb.db);
      const dashboard = fixture.chat("webchat", "chat-1", "dm", "Weekly planning");
      fixture.speaker({ id: "dashboard", chat: dashboard, accountId: "guardian" });
      const dm = fixture.chat("telegram", "dana", "dm", "Dana");
      fixture.speaker({ id: "dm", chat: dm, accountId: "bot-sales" });
      const group = fixture.chat("telegram", "-42", "group", "Release crew");
      fixture.speaker({ id: "group", chat: group, accountId: "bot-sales" });
      fixture.speaker({
        id: "topic",
        chat: group,
        accountId: "bot-sales",
        threadId: "7",
        name: "Launch topic",
      });
      // A speaker of an account Rome no longer records still reads its platform.
      fixture.speaker({ id: "stray", chat: group, accountId: "bot-gone" });
      testDb.db
        .insert(romeSessions)
        .values({ id: "sub", name: "Sub", type: "subagent", createdAt: at, activityAt: at })
        .run();
      // One run each, as the explorer lists only sessions that ran.
      for (const sessionId of ["dashboard", "dm", "group", "topic", "stray", "sub"]) {
        testDb.db
          .insert(romeAgentMessages)
          .values({
            id: `trace-${sessionId}`,
            sessionId,
            role: "trace",
            content: "[]",
            turnId: `turn-${sessionId}`,
            createdAt: new Date(1000),
          })
          .run();
      }
    }

    async function page(repository: SessionQueryRepository, scope = {}) {
      return repository.querySessionPage({
        scope: { from: null, to: new Date(10_000_000), ...scope },
        sort: { field: "activity", direction: "desc" },
        offset: 0,
        limit: 10,
      });
    }

    it("reads where each session stands from its speaker's chat and account", async () => {
      seeded();
      const repository = new SessionQueryRepository(testDb.db);

      const rows = Object.fromEntries(
        (await page(repository)).rows.map((row) => [
          row.id,
          [row.chatPlatform, row.accountId, row.placeName, row.placeKind],
        ]),
      );

      expect(rows).toEqual({
        dashboard: ["webchat", "guardian", "Weekly planning", "directMessage"],
        dm: ["telegram", "bot-sales", "Dana", "directMessage"],
        group: ["telegram", "bot-sales", "Release crew", "group"],
        topic: ["telegram", "bot-sales", "Launch topic", "thread"],
        stray: ["telegram", "bot-gone", "Release crew", "group"],
        sub: [null, null, null, null],
      });
      const detail = await repository.getSessionDetailRows("topic");
      expect([detail?.session.placeName, detail?.session.placeKind]).toEqual([
        "Launch topic",
        "thread",
      ]);
    });

    it("filters and counts sessions by the platform of the chat they stand in", async () => {
      seeded();
      const repository = new SessionQueryRepository(testDb.db);

      const onTelegram = await page(repository, { platforms: ["telegram"] });
      const noChat = await page(repository, { includeNoChat: true, platforms: [] });

      expect(onTelegram.rows.map((row) => row.id).sort()).toEqual([
        "dm",
        "group",
        "stray",
        "topic",
      ]);
      expect(noChat.rows.map((row) => row.id)).toEqual(["sub"]);
      expect(
        Object.fromEntries(
          (await page(repository)).facets.platforms.map((facet) => [facet.value, facet.count]),
        ),
      ).toEqual({ webchat: 1, telegram: 4, null: 1 });
    });
  });

  describe("counting messages from Chats", () => {
    const at = (seconds: number) => new Date(seconds * 1000);

    /** A row the session keeps itself in `rome_agent_messages`. */
    function own(sessionId: string, id: string, role: string, seconds: number) {
      testDb.db
        .insert(romeAgentMessages)
        .values({
          id,
          sessionId,
          role,
          content: "[]",
          turnId: `turn-${id}`,
          createdAt: at(seconds),
        })
        .run();
    }

    /** A dashboard chat whose speaker joined at 100 s: one line before it
     *  joined, two after, a trace, and the legacy copies of its two lines. */
    function seededChat() {
      const fixture = speakerFixture(testDb.db);
      const chat = fixture.chat("webchat", "chat-1", "dm", "Chat");
      fixture.speaker({ id: "chat-1", chat, accountId: "guardian", createdAt: at(100) });
      fixture.say({ id: "before", chat, from: "guardian", at: at(50) });
      fixture.say({ id: "q", chat, from: "guardian", at: at(200) });
      fixture.say({ id: "a", chat, from: "agent:main", agent: "main", at: at(202) });
      own("chat-1", "trace", "trace", 201);
      own("chat-1", "q", "user", 200);
      own("chat-1", "a", "assistant", 202);
    }

    /** A subagent in no chat, which keeps its prompt, trace and answer. */
    function seededSubagent() {
      testDb.db
        .insert(romeSessions)
        .values({ id: "sub", name: "Sub", type: "subagent", createdAt: at(0), activityAt: at(0) })
        .run();
      own("sub", "sub-q", "user", 300);
      own("sub", "sub-trace", "trace", 301);
      own("sub", "sub-a", "assistant", 302);
    }

    async function pageCounts(repository: SessionQueryRepository) {
      const page = await repository.querySessionPage({
        scope: { from: null, to: at(10_000) },
        sort: { field: "activity", direction: "desc" },
        offset: 0,
        limit: 10,
      });
      return Object.fromEntries(page.rows.map((row) => [row.id, row.messageCount]));
    }

    it("counts what was said where the speaker stands since it joined, and its traces, once", async () => {
      seededChat();
      seededSubagent();
      const repository = new SessionQueryRepository(testDb.db, "chats");

      expect(await pageCounts(repository)).toEqual({ "chat-1": 3, sub: 3 });
      expect((await repository.getSessionDetailRows("chat-1"))?.messageCount).toBe(3);
      expect((await repository.getSessionDetailRows("sub"))?.messageCount).toBe(3);
    });

    // A session in a chat counts only its traces of what it keeps in
    // `rome_agent_messages`: a dashboard notice is not a message in Chats (#1672).
    it("counts none of a chat session's own rows but its traces", async () => {
      seededChat();
      own("chat-1", "notice", "notification", 203);
      const repository = new SessionQueryRepository(testDb.db, "chats");

      expect(await pageCounts(repository)).toEqual({ "chat-1": 3 });
      expect((await repository.getSessionDetailRows("chat-1"))?.messageCount).toBe(3);
    });

    it("counts messages only for the sessions on the page", async () => {
      seededChat();
      seededSubagent();
      type Statement = { all(...values: unknown[]): unknown[] };
      const client = (testDb.db as unknown as { $client: { prepare(sql: string): Statement } })
        .$client;
      const prepare = client.prepare.bind(client);
      const counted: unknown[][] = [];
      client.prepare = (text: string) => {
        const statement = prepare(text);
        const all = statement.all.bind(statement);
        statement.all = (...values: unknown[]) => {
          if (text.includes("FROM chat_messages")) counted.push(values);
          return all(...values);
        };
        return statement;
      };
      try {
        const page = await new SessionQueryRepository(testDb.db, "chats").querySessionPage({
          scope: { from: null, to: at(10_000) },
          sort: { field: "activity", direction: "desc" },
          offset: 0,
          limit: 1,
        });
        expect(page.rows).toHaveLength(1);
      } finally {
        client.prepare = prepare;
      }

      // One count, over the one session the page shows.
      expect(counted).toHaveLength(1);
      expect(JSON.parse(String(counted[0]?.[0]))).toHaveLength(1);
    });

    it("counts the session's own rows when it reads the legacy tables", async () => {
      seededChat();
      const repository = new SessionQueryRepository(testDb.db);

      expect(await pageCounts(repository)).toEqual({ "chat-1": 3 });
      expect((await repository.getSessionDetailRows("chat-1"))?.messageCount).toBe(3);
    });
  });
});
