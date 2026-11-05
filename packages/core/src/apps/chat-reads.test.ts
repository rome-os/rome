// What an app reads of the chats Rome's sessions stand in, over Chats'
// tables. Vocabulary: docs/domains/chats.md.

import { createTurnReads } from "../agent-sessions/index.js";
import { beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import type { ChatReads } from "@rome-os/app-runtime/chats";
import type { ChatRef } from "../chats/storage/place.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { channels, connectedAccounts, connections, romeAgentMessages } from "../db/schema.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { speakerFixture } from "../test/speakers.js";
import { ChatReadModel } from "../webchat/chat-read-model.js";
import { appChatReads } from "./chat-reads.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";

const at = (seconds: number) => new Date(seconds * 1000);

describe("appChatReads", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;
  let links: TurnLinks;
  let fixture: ReturnType<typeof speakerFixture>;
  let reads: ChatReads;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ChatsWebChatRepository(testDb.db);
    links = new TurnLinks(testDb.db);
    fixture = speakerFixture(testDb.db);
    reads = appChatReads({
      db: testDb.db,
      reads: new ChatReadModel(testDb.db),
      turns: createTurnReads(testDb.db, repo),
    });
  });

  /** A dashboard chat and the agent's session in it, opened under `id`. */
  function dashboardChat(id: string, ownerKey = "guardian"): ChatRef {
    const chat = fixture.chat("webchat", id, "dm", id);
    fixture.speaker({ id, chat, accountId: "guardian", ownerKey, createdAt: at(0) });
    return chat;
  }

  function telegramBot() {
    testDb.db
      .insert(channels)
      .values({
        id: "telegram",
        connectionKind: "telegram",
        platform: "telegram",
        platformAccountId: "rome-bot",
        createdAt: at(0),
      })
      .run();
  }

  describe("recentChats", () => {
    it("lists the dashboard's chats with a line since the cutoff, the latest active first", async () => {
      const older = dashboardChat("chat-old");
      const newer = dashboardChat("chat-new");
      const quiet = dashboardChat("chat-quiet");
      fixture.say({ id: "u-1", chat: older, from: "guardian", at: at(2_000) });
      fixture.say({ id: "u-2", chat: newer, from: "guardian", at: at(3_000) });
      fixture.say({ id: "u-3", chat: quiet, from: "guardian", at: at(500) });

      const recent = await reads.recentChats({ since: at(1_000), where: "dashboard" });

      expect(recent.map((chat) => [chat.sessionId, chat.chat])).toEqual([
        ["chat-new", newer],
        ["chat-old", older],
      ]);
      expect(recent[0]).toMatchObject({ ownerKey: "guardian", archived: false, channel: null });
    });

    it("lists chats on Rome's accounts of the kinds named, with the channel that is the account", async () => {
      telegramBot();
      const group = fixture.chat("telegram", "-100", "group", "Ops");
      fixture.speaker({ id: "s-1", chat: group, accountId: "rome-bot", createdAt: at(0) });
      fixture.say({ id: "m-1", chat: group, from: "alice", at: at(2_000) });
      const dashboard = dashboardChat("chat-1");
      fixture.say({ id: "u-1", chat: dashboard, from: "guardian", at: at(2_000) });

      const recent = await reads.recentChats({
        since: at(1_000),
        where: { accountKinds: ["telegram"] },
      });

      expect(recent.map((chat) => [chat.sessionId, chat.channel])).toEqual([
        ["s-1", { name: "telegram", kind: "telegram" }],
      ]);
      expect(
        await reads.recentChats({ since: at(1_000), where: { accountKinds: ["discord"] } }),
      ).toEqual([]);
    });

    it("names each session's place: its chat's name, or its topic's", async () => {
      telegramBot();
      const group = fixture.chat("telegram", "-100", "group", "Ops");
      fixture.speaker({ id: "s-group", chat: group, accountId: "rome-bot", createdAt: at(0) });
      fixture.speaker({
        id: "s-topic",
        chat: group,
        accountId: "rome-bot",
        threadId: "7",
        name: "Launch",
        createdAt: at(0),
      });
      fixture.say({ id: "m-1", chat: group, from: "alice", at: at(2_000) });
      fixture.say({ id: "m-2", chat: group, threadId: "7", from: "alice", at: at(2_100) });

      const recent = await reads.recentChats({
        since: at(1_000),
        where: { accountKinds: ["telegram"] },
      });

      expect(recent.map((chat) => [chat.sessionId, chat.threadName])).toEqual([
        ["s-topic", "Launch"],
        ["s-group", "Ops"],
      ]);
    });

    it("lists a chat by its channel's kind, even on a platform the kind is not named for", async () => {
      testDb.db
        .insert(channels)
        .values({
          id: "lark",
          connectionKind: "feishu",
          platform: "lark",
          platformAccountId: "rome-lark",
          createdAt: at(0),
        })
        .run();
      const group = fixture.chat("lark", "oc_1", "group", "Ops");
      fixture.speaker({ id: "s-1", chat: group, accountId: "rome-lark", createdAt: at(0) });
      fixture.say({ id: "m-1", chat: group, from: "alice", at: at(2_000) });

      const recent = await reads.recentChats({
        since: at(1_000),
        where: { accountKinds: ["feishu"] },
      });

      expect(recent.map((chat) => [chat.sessionId, chat.channel])).toEqual([
        ["s-1", { name: "lark", kind: "feishu" }],
      ]);
    });

    it("names the agent the connected account holds now, not the channel's retired one", async () => {
      testDb.db
        .insert(connections)
        .values({ id: "conn-1", connectionKind: "telegram", label: "Bot", createdAt: at(0) })
        .run();
      testDb.db
        .insert(channels)
        .values({
          id: "telegram",
          connectionKind: "telegram",
          platform: "telegram",
          connectionId: "conn-1",
          platformAccountId: "rome-bot",
          createdAt: at(0),
          agent: "old:agent",
        })
        .run();
      const link = (agent: string | null) =>
        testDb.db
          .insert(connectedAccounts)
          .values({ platform: "telegram", accountId: "rome-bot", agent })
          .onConflictDoUpdate({
            target: [connectedAccounts.platform, connectedAccounts.accountId],
            set: { agent },
          })
          .run();
      const dm = fixture.chat("telegram", "dm:rome-bot:42", "dm", "Wei");
      fixture.speaker({ id: "s-1", chat: dm, accountId: "rome-bot", createdAt: at(0) });
      fixture.say({ id: "m-1", chat: dm, from: "42", at: at(2_000) });
      const agentNow = async () =>
        (await reads.recentChats({ since: at(1_000), where: { accountKinds: ["telegram"] } }))[0]
          ?.agentName;

      link("sales:agent");
      expect(await agentNow()).toBe("sales:agent");
      link("support:agent");
      expect(await agentNow()).toBe("support:agent");
      link(null);
      expect(await agentNow()).toBeNull();
    });

    it("leaves out a chat whose only lines were said before the session came to stand there", async () => {
      const group = fixture.chat("telegram", "-100", "group");
      fixture.say({ id: "m-1", chat: group, from: "alice", at: at(2_000) });
      fixture.speaker({ id: "s-1", chat: group, accountId: "rome-bot", createdAt: at(3_000) });

      expect(
        await reads.recentChats({ since: at(0), where: { accountKinds: ["telegram"] } }),
      ).toEqual([]);
    });
  });

  describe("transcript", () => {
    it("reads a chat's lines since the cutoff, each with its turn and sender", async () => {
      const chat = dashboardChat("chat-1");
      const early = fixture.say({ id: "u-0", chat, from: "guardian", text: "hi", at: at(500) });
      links.prompt(early, "chat-1", "turn-0");
      const asked = fixture.say({ id: "u-1", chat, from: "guardian", text: "q", at: at(2_000) });
      links.prompt(asked, "chat-1", "turn-1");
      const answered = fixture.say({
        id: "a-1",
        chat,
        from: "agent:main",
        agent: "main",
        text: "a",
        at: at(2_001),
      });
      links.answer(answered, "chat-1", "turn-1");

      const lines = await reads.transcript("chat-1", { since: at(1_000) });

      expect(lines.map((line) => [line.key, line.role, line.turnId, line.senderId])).toEqual([
        ["u-1", "user", "turn-1", "guardian"],
        ["a-1", "assistant", "turn-1", "agent:main"],
      ]);
      expect(JSON.parse(lines[0]?.content ?? "[]")).toEqual([{ type: "text", content: "q" }]);
      expect(await reads.transcript("chat-1")).toHaveLength(3);
    });

    it("is empty for a session Rome does not hold", async () => {
      expect(await reads.transcript("nobody")).toEqual([]);
    });
  });

  describe("traces", () => {
    it("reads a session's traces oldest first, with their blocks and what the turn used", async () => {
      dashboardChat("chat-1");
      for (const [id, turnId, seconds] of [
        ["t-2", "turn-2", 2_000],
        ["t-1", "turn-1", 1_000],
      ] as const) {
        await repo.appendTraceBlocks({
          messageId: id,
          sessionId: "chat-1",
          turnId,
          startSeq: 0,
          blocks: [{ type: "turn_end", turnId, status: "completed", durationMs: 1 }],
        });
        testDb.db
          .update(romeAgentMessages)
          .set({ createdAt: at(seconds), inputTokens: 10 })
          .where(sql`${romeAgentMessages.id} = ${id}`)
          .run();
      }

      const traces = await reads.traces("chat-1");

      expect(traces.map((trace) => [trace.id, trace.turnId, trace.inputTokens])).toEqual([
        ["t-1", "turn-1", 10],
        ["t-2", "turn-2", 10],
      ]);
      expect(JSON.parse(traces[0]?.content ?? "[]")).toEqual([
        expect.objectContaining({ type: "turn_end", turnId: "turn-1" }),
      ]);
    });

    it("is empty for a session with no traces", async () => {
      expect(await reads.traces("nobody")).toEqual([]);
    });
  });
});
