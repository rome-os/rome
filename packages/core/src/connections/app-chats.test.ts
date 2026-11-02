// What an app's `deps.chats` does: send into a place Chats named, as the
// speaker there or Rome's main agent, and resolve a direct message or a group
// to its ref. Vocabulary: docs/domains/chats.md.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type {
  Account,
  Channel,
  ChatId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import { type ChatsPort, isSendError, SendError } from "@rome-os/app-runtime/chats";
import { sql } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { SpeakerReplies } from "../sessions/speaker-replies.js";
import { Speakers } from "../sessions/speakers.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { speakerFixture } from "../test/speakers.js";
import { appChats } from "./app-chats.js";
import { ChatAddresses } from "./chat-addresses.js";
import { ChatAdapters, chatAt } from "./chat-adapter.js";
import { chatKey } from "./chat-ids.js";

const BOT: Account = { platform: "telegram", id: "rome-bot" };
const SECOND_BOT: Account = { platform: "telegram", id: "rome-bot-2" };
const DISCORD: Account = { platform: "discord", id: "rome-discord" };
const BOB: Account = { platform: "discord", id: "bob" };

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isSendError(error)) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("appChats", () => {
  let testDb: TestDb;
  let fixture: ReturnType<typeof speakerFixture>;
  let sent: Array<{ channel: string; address: string; message: OutgoingMessage }>;
  /** The platform's answer to a send, by address: where it landed, or a
   *  refusal. */
  let landsAt: Record<string, string>;
  let refuse: boolean;
  /** Runs while the platform takes a send. */
  let duringSend: () => void;
  /** The Discord DM channel the platform opens for each person. */
  let opened: Record<string, string | null>;
  let opens: string[];
  let accounts: Record<string, Account>;
  let chats: ChatsPort;

  beforeEach(() => {
    testDb = createTestDb();
    fixture = speakerFixture(testDb.db);
    sent = [];
    landsAt = {};
    refuse = false;
    duringSend = () => {};
    opened = { bob: "dm-chan-bob", carol: null };
    opens = [];
    accounts = { telegram: BOT, discord: DISCORD };
    let next = 0;
    const channel = (name: string): Channel =>
      ({
        name,
        inbound: null,
        send: {
          send: async (address: ChatId, message: OutgoingMessage) => {
            if (refuse) throw new Error("chat not found on the platform");
            duringSend();
            sent.push({ channel: name, address, message });
            return {
              chatId: (landsAt[address] ?? address) as ChatId,
              messageId: `m-${++next}`,
            } satisfies MessageReceipt;
          },
          direct: {
            chatFor: async (id: string) => {
              opens.push(id);
              return (opened[id] ?? null) as ChatId | null;
            },
          },
        },
      }) as unknown as Channel;
    const live = ["telegram", "telegram-2", "discord"].map(channel);
    const chatRepo = new ChatRepository(testDb.db);
    const messages = new MessageRepository(testDb.db);
    const speakers = new Speakers(testDb.db, chatRepo);
    const addresses = new ChatAddresses(testDb.db);
    const channelsOn = (platform: string) =>
      Object.keys(accounts).filter((name) => accounts[name]?.platform === platform);
    const adapters = new ChatAdapters({
      accountOf: (name) => accounts[name] ?? null,
      platformOfChannel: (name) => accounts[name]?.platform ?? name,
      addresses,
      keyOf: (ref) => {
        const chat = chatRepo.get(ref);
        if (!chat) throw new Error(`No chat ${ref.id}`);
        return chatKey(ref.platform, chat.key as ChatId);
      },
      channelsOn,
    });
    chats = appChats({
      channels: () => live,
      channelsOn,
      adapters,
      chats: chatRepo,
      speakers,
      replies: new SpeakerReplies({
        speakers,
        adapters,
        messages,
        links: new TurnLinks(testDb.db, messages),
      }),
      messages,
    });
  });
  afterEach(() => testDb.close());

  const lines = () =>
    testDb.db.all<{ chat_id: number; thread_id: string | null; text: string; agent: string }>(
      sql`SELECT chat_id, thread_id, text, sender_agent AS agent FROM chat_messages ORDER BY id`,
    );

  describe("send", () => {
    it("sends into a group as Rome's only account there and records it as the main agent", async () => {
      const group = fixture.chat("telegram", "-100", "group", "Ops");

      const result = await chats.send(group, { text: "Deploy done" });

      expect(sent).toEqual([
        { channel: "telegram", address: "-100", message: { text: "Deploy done" } },
      ]);
      expect(lines()).toEqual([
        { chat_id: group.id, thread_id: null, text: "Deploy done", agent: "main" },
      ]);
      expect(result.message.chat).toEqual(group);
      expect(result.message.id).toBeGreaterThan(0);
      expect(result.platformMessageId).toBe("m-1");
      expect(result.thread).toBeUndefined();
    });

    it("sends as the speaker there, so the line is its agent's", async () => {
      const group = fixture.chat("telegram", "-100", "group");
      fixture.speaker({ id: "s1", chat: group, accountId: BOT.id, agentName: "concierge" });

      await chats.send(group, { text: "On it." });

      expect(lines().map((line) => line.agent)).toEqual(["concierge"]);
    });

    it("refuses a chat Rome holds no record of, and sends nothing", async () => {
      expect(await refusal(chats.send({ platform: "telegram", id: 999 }, { text: "x" }))).toBe(
        "chat_not_found",
      );
      expect(sent).toEqual([]);
    });

    it("asks which account to send as when Rome holds several on the platform and none speaks there", async () => {
      accounts["telegram-2"] = SECOND_BOT;
      const group = fixture.chat("telegram", "-100", "group");

      expect(await refusal(chats.send(group, { text: "x" }))).toBe("sender_ambiguous");

      await chats.send(group, { text: "From the second" }, { as: SECOND_BOT });
      expect(sent.map((send) => send.channel)).toEqual(["telegram-2"]);
    });

    it("sends as the one of several accounts that speaks in the chat", async () => {
      accounts["telegram-2"] = SECOND_BOT;
      const group = fixture.chat("telegram", "-100", "group");
      fixture.speaker({ id: "s2", chat: group, accountId: SECOND_BOT.id });

      await chats.send(group, { text: "x" });

      expect(sent.map((send) => send.channel)).toEqual(["telegram-2"]);
    });

    it("refuses to send a direct message as an account that is not its end", async () => {
      accounts["telegram-2"] = SECOND_BOT;
      const dm = fixture.chat(
        "telegram",
        chatAt("telegram", "42", { romeEnd: BOT.id }).externalId,
        "dm",
      );

      expect(await refusal(chats.send(dm, { text: "x" }, { as: SECOND_BOT }))).toBe(
        "sender_not_in_chat",
      );
      await chats.send(dm, { text: "Hi" });
      expect(sent).toEqual([{ channel: "telegram", address: "42", message: { text: "Hi" } }]);
    });

    it("sends into the thread a message was said in", async () => {
      const group = fixture.chat("discord", "guild-chan", "group");
      const said = fixture.say({
        id: "t-1",
        chat: group,
        threadId: "thread-7",
        from: "bob",
        at: new Date(0),
      });

      await chats.send({ chat: group, id: said }, { text: "Second line." });

      expect(sent.map((send) => send.address)).toEqual(["thread-7"]);
      expect(lines().at(-1)?.thread_id).toBe("thread-7");
    });

    it("opens the thread off a message in the open chat by answering it, and names the thread it landed in", async () => {
      const group = fixture.chat("discord", "guild-chan", "group");
      const said = fixture.say({ id: "q-1", chat: group, from: "bob", at: new Date(0) });
      landsAt["guild-chan"] = "thread-new";

      const result = await chats.send({ chat: group, id: said }, { text: "In a thread." });

      expect(sent[0]?.message.replyToMessageId).toBe("q-1");
      expect(result.thread).toEqual({ chat: group, id: result.message.id });

      await chats.send(result.thread!, { text: "And again." });
      expect(sent.map((send) => send.address)).toEqual(["guild-chan", "thread-new"]);
    });

    it("refuses a thread named by a message of another chat", async () => {
      const group = fixture.chat("discord", "guild-chan", "group");
      const other = fixture.chat("discord", "other-chan", "group");
      const said = fixture.say({ id: "q-1", chat: other, from: "bob", at: new Date(0) });

      expect(await refusal(chats.send({ chat: group, id: said }, { text: "x" }))).toBe(
        "chat_not_found",
      );
      expect(sent).toEqual([]);
    });

    it("refuses to quote another message in a send that opens a thread off one, and sends nothing", async () => {
      const group = fixture.chat("discord", "guild-chan", "group");
      const opening = fixture.say({ id: "q-1", chat: group, from: "bob", at: new Date(0) });
      const other = fixture.say({ id: "q-2", chat: group, from: "bob", at: new Date(0) });

      expect(
        await refusal(
          chats.send(
            { chat: group, id: opening },
            { text: "x", replyTo: { chat: group, id: other } },
          ),
        ),
      ).toBe("unsupported");
      expect(sent).toEqual([]);
    });

    it("sends as the one account that speaks in the thread, though none speaks in the open chat", async () => {
      accounts["telegram-2"] = SECOND_BOT;
      const group = fixture.chat("telegram", "-100", "group");
      fixture.speaker({ id: "s2", chat: group, accountId: SECOND_BOT.id, threadId: "topic-9" });
      const said = fixture.say({
        id: "t-1",
        chat: group,
        threadId: "topic-9",
        from: "alice",
        at: new Date(0),
      });

      await chats.send({ chat: group, id: said }, { text: "x" });

      expect(sent.map((send) => [send.channel, send.address])).toEqual([["telegram-2", "topic-9"]]);
    });

    it("never puts a part only the host makes on record or on the platform", async () => {
      const group = fixture.chat("telegram", "-100", "group");

      await chats.send(group, {
        text: "Brief",
        parts: [
          { type: "text", content: "Brief" },
          { type: "routine_draft_card", draft: {} } as never,
        ],
      });

      const recorded = testDb.db.all<{ parts: string }>(sql`SELECT parts FROM chat_messages`);
      expect(JSON.parse(recorded[0]?.parts ?? "[]")).toEqual([{ type: "text", content: "Brief" }]);
      expect(sent[0]?.message.parts).toEqual([{ type: "text", content: "Brief" }]);
    });

    it("answers a send the platform took even when its chat ends meanwhile", async () => {
      const group = fixture.chat("telegram", "-100", "group");
      duringSend = () => testDb.db.run(sql`DELETE FROM chats WHERE id = ${group.id}`);

      const result = await chats.send(group, { text: "Deploy done" });

      expect(result.delivery.state).toBe("sent");
      expect(sent).toHaveLength(1);
    });

    it("answers a platform's refusal as failed and records nothing", async () => {
      const group = fixture.chat("telegram", "-100", "group");
      refuse = true;

      const error = await chats.send(group, { text: "x" }).catch((caught) => caught);

      expect(error).toBeInstanceOf(SendError);
      expect(error.code).toBe("failed");
      expect(lines()).toEqual([]);
    });
  });

  describe("dm", () => {
    it("opens the direct message through the channel and keeps it, so the next call asks nothing", async () => {
      const first = await chats.dm(BOB);
      const again = await chats.dm(BOB);

      expect(again).toEqual(first);
      expect(opens).toEqual(["bob"]);

      await chats.send(first, { text: "Brief ready." });
      expect(sent).toEqual([
        { channel: "discord", address: "dm-chan-bob", message: { text: "Brief ready." } },
      ]);
    });

    it("refuses when the platform opens no direct message", async () => {
      expect(await refusal(chats.dm({ platform: "discord", id: "carol" }))).toBe("no_dm");
    });

    it("refuses on a platform where Rome holds no account", async () => {
      expect(await refusal(chats.dm({ platform: "slack", id: "U1" }))).toBe("not_connected");
    });
  });

  describe("group", () => {
    it("answers every group by that name, and no direct message", async () => {
      const first = fixture.chat("discord", "a", "group", "standup");
      const second = fixture.chat("discord", "b", "group", "standup");
      fixture.chat("discord", "c", "group", "random");
      fixture.chat("discord", "dm:rome-discord:standup", "dm", "standup");

      expect(await chats.group({ platform: "discord", name: "standup" })).toEqual([first, second]);
    });

    it("narrows to the groups the named account speaks in", async () => {
      fixture.chat("telegram", "-1", "group", "ops");
      const spoken = fixture.chat("telegram", "-2", "group", "ops");
      fixture.speaker({ id: "s1", chat: spoken, accountId: BOT.id });

      expect(await chats.group({ platform: "telegram", name: "ops", as: BOT })).toEqual([spoken]);
    });
  });
});
