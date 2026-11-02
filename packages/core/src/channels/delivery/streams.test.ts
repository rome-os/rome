import { describe, expect, it, rs } from "@rstest/core";
import type { Channel } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { chatAt, platformIdOfLine } from "../../chats/adapter.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
import { systemClock } from "../../lib/clock.js";
import { createTestDb, testChatWiring } from "../../test/helpers.js";
import { seatFixture } from "../../test/seats.js";
import { Pacer } from "./pacer.js";
import { ReplyStreams } from "./streams.js";
import { DeliveryFailure, type DeliveryTransport, plainText } from "./types.js";

const budget = { burst: 100, refillMs: 1, conversationSpacingMs: 0 };
const transport: DeliveryTransport = {
  capabilities: { maxPartLength: 5, edit: false, budget },
  codec: plainText,
  create: async (conversation, text) => ({
    messageId: `id-${text.trim()}`,
    chatId: conversation,
  }),
};
const target = {
  channel: "telegram",
  chatId: "chat-1",
  replyToMessageId: "msg-1",
  romeSessionId: "conversation-1",
  turnId: "turn-1",
};
const key = chatAt("telegram", "chat-1");

/**
 * Reply streams over `transport` on Telegram, said through Rome's seat
 * `conversation-1` in the Telegram chat at `chat-1`, with what the seat put
 * on record.
 */
function streamsOver(
  over: DeliveryTransport = transport,
  streaming: () => Promise<boolean> = async () => true,
) {
  const testDb = createTestDb();
  const repo = new WebChatRepository(testDb.db);
  const fixture = seatFixture(testDb.db);
  const chat = fixture.chat(key.platform, key.externalId, "group");
  fixture.seat({ id: "conversation-1", chat, accountId: "telegram" });
  const lookup = rs.fn((name: string) =>
    name === "telegram"
      ? ({
          name: "telegram",
          send: { replies: { transport: over, pacer: new Pacer(budget, systemClock) } },
          inbound: null,
        } as unknown as Channel)
      : undefined,
  );
  const streams = new ReplyStreams({
    streaming,
    channel: lookup,
    clock: systemClock,
    said: testChatWiring(testDb.db, repo).replies,
  });
  /** Rome's lines in the chat, with the platform id each went out as. */
  const recorded = () =>
    testDb.db
      .all<{ key: string; text: string; sender_agent: string | null }>(
        sql`SELECT key, text, sender_agent FROM chat_messages ORDER BY id`,
      )
      .map((line) => ({
        text: line.text,
        platformMessageId: platformIdOfLine(key, "telegram", line.key),
        byRome: line.sender_agent !== null,
      }));
  /** The seat's answer to turn-1, as the turn links it. */
  const answers = () =>
    testDb.db.all<{ message_id: string }>(
      sql`SELECT message_id FROM agent_turn_messages WHERE role = 'answer' AND turn_id = 'turn-1'`,
    );
  return { streams, lookup, recorded, answers, close: () => testDb.close() };
}

describe("ReplyStreams", () => {
  it("opens no stream while reply streaming is off, and does not look at the channel", async () => {
    const { streams, lookup, close } = streamsOver(transport, async () => false);
    try {
      expect(await streams.open(target)).toBeNull();
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("opens no stream on a channel that cannot stream", async () => {
    const { streams, close } = streamsOver();
    try {
      expect(await streams.open({ ...target, channel: "discord" })).toBeNull();
    } finally {
      close();
    }
  });

  it("reads the switch each time a reply opens", async () => {
    let on = false;
    const { streams, close } = streamsOver(transport, async () => on);
    try {
      expect(await streams.open(target)).toBeNull();
      on = true;
      expect(await streams.open(target)).not.toBeNull();
    } finally {
      close();
    }
  });

  it("records the delivered reply once, as the text the user was shown, as the turn's answer", async () => {
    const { streams, recorded, answers, close } = streamsOver();
    try {
      const stream = (await streams.open(target))!;
      stream.accept({ type: "result", content: "one two" });
      expect((await stream.settle(false)).status).toBe("delivered");

      expect(recorded()).toEqual([{ text: "one two", platformMessageId: "id-one", byRome: true }]);
      expect(answers()).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("records the source the messages show, not the codec's rendering of each", async () => {
    const { streams, recorded, close } = streamsOver({
      ...transport,
      codec: { ...plainText, render: (s) => `[${s}]` },
    });
    try {
      const stream = (await streams.open(target))!;
      stream.accept({ type: "result", content: "a b c" });
      await stream.settle(false);

      expect(recorded().map((line) => line.text)).toEqual(["a b c"]);
    } finally {
      close();
    }
  });

  it("records each block as its own paragraph, as one line under the reply's first message", async () => {
    const { streams, recorded, close } = streamsOver();
    try {
      const stream = (await streams.open(target))!;
      stream.accept({ type: "text", content: "one two" });
      stream.accept({ type: "text", content: "six", turnPhase: "final" });
      stream.accept({ type: "result", content: "six" });
      await stream.settle(false);

      expect(recorded()).toEqual([
        { text: "one two\n\nsix", platformMessageId: "id-one", byRome: true },
      ]);
    } finally {
      close();
    }
  });

  it("records the reply under the last block with a message id, when the answer's create is unknown", async () => {
    const { streams, recorded, close } = streamsOver({
      ...transport,
      create: async (conversation, text) => {
        if (text === "six") throw new DeliveryFailure("unknown", "no answer");
        return { messageId: `id-${text.trim()}`, chatId: conversation };
      },
    });
    try {
      const stream = (await streams.open(target))!;
      stream.accept({ type: "text", content: "one two" });
      stream.accept({ type: "text", content: "six", turnPhase: "final" });
      stream.accept({ type: "result", content: "six" });
      expect((await stream.settle(false)).status).toBe("unknown");

      expect(recorded()).toEqual([
        { text: "one two\n\nsix", platformMessageId: "id-one", byRome: true },
      ]);
    } finally {
      close();
    }
  });

  it("shows the answer WebChat shows, for a structured result and for a turn that ends mid-block", async () => {
    const { streams, recorded, close } = streamsOver();
    try {
      // An agent with an output schema streams no text. Its answer is the
      // result's JSON.
      const structured = (await streams.open(target))!;
      structured.accept({ type: "result", content: '{"ok":true}' });
      await structured.settle(false);

      // A turn can end before its block's text event. The text that streamed
      // is the answer, and the result repeats it.
      const cut = (await streams.open({ ...target, turnId: "turn-2" }))!;
      cut.accept({ type: "text_delta", content: "one " });
      cut.accept({ type: "text_delta", content: "two" });
      cut.accept({ type: "result", content: "one two" });
      await cut.settle(false);

      expect(recorded().map((line) => line.text)).toEqual(['{"ok":true}', "one two"]);
    } finally {
      close();
    }
  });

  it("records nothing when no message was written, so a failed stream leaves no history", async () => {
    const { streams, recorded, close } = streamsOver({
      ...transport,
      create: async () => {
        throw new DeliveryFailure("rejected", "refused");
      },
    });
    try {
      const stream = (await streams.open(target))!;
      stream.accept({ type: "result", content: "one" });
      expect((await stream.settle(false)).status).toBe("failed");
      expect(recorded()).toEqual([]);
    } finally {
      close();
    }
  });

  it("records a message whose create may have landed, since nothing sends it again", async () => {
    const { streams, recorded, answers, close } = streamsOver({
      ...transport,
      create: async () => {
        throw new DeliveryFailure("unknown", "no answer");
      },
    });
    try {
      const stream = (await streams.open(target))!;
      stream.accept({ type: "result", content: "one" });
      expect((await stream.settle(false)).status).toBe("unknown");

      expect(recorded()).toEqual([{ text: "one", platformMessageId: null, byRome: true }]);
      expect(answers()).toHaveLength(1);
    } finally {
      close();
    }
  });
});
