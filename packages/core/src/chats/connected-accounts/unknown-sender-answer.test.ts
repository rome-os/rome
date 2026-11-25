import { describe, expect, it } from "@rstest/core";
import type { ChatId, OutgoingMessage } from "@rome-os/app-runtime";
import type { Connection } from "../../connections/types.js";
import type { UnknownSenderMessage } from "../../participation/unknown-senders.js";
import {
  ANSWERED_KEPT,
  answerUnknownSenders,
  unknownSenderAnswer,
} from "./unknown-sender-answer.js";

const ORIGIN = "https://sam.romeos.io";
const LINK = `${ORIGIN}/connect-account`;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

interface Sent {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  onlyTo?: string;
}

function harness(options: { privately?: boolean; origin?: string | null; fails?: boolean } = {}) {
  const sent: Sent[] = [];
  let clock = 0;
  const talker = {
    async send(chatId: ChatId, message: OutgoingMessage) {
      if (options.fails) throw new Error("the sender wrote: secret words");
      sent.push({
        chatId,
        text: message.text ?? "",
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      });
      return {};
    },
    ...(options.privately
      ? {
          privateMessaging: {
            async sendOnlyTo(
              chatId: ChatId,
              accountId: string,
              text: string,
              opts?: { replyToMessageId?: string },
            ) {
              sent.push({
                chatId,
                text,
                onlyTo: accountId,
                ...(opts?.replyToMessageId ? { replyToMessageId: opts.replyToMessageId } : {}),
              });
            },
          },
        }
      : {}),
  };
  const connection = {
    id: "conn-1",
    connectionKind: "slack_app",
    withTalker: (call: (live: typeof talker) => unknown) => call(talker),
  } as unknown as Connection;
  const tell = answerUnknownSenders({
    registry: {
      get: (id) => {
        if (id !== connection.id) throw new Error(`unknown connection "${id}"`);
        return connection;
      },
    },
    publicOrigin: () => (options.origin === undefined ? ORIGIN : options.origin),
    now: () => clock,
  });
  return {
    tell,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function message(
  fields: Partial<Omit<UnknownSenderMessage, "sender">> & { senderId?: string } = {},
): UnknownSenderMessage {
  const { senderId = "T1/U9", ...rest } = fields;
  return {
    messageId: 1,
    sender: { platform: "slack", id: senderId },
    connectionId: "conn-1",
    channel: "slack_app",
    chatId: "D1" as ChatId,
    platformMessageId: "1.2",
    addressing: "direct",
    ...rest,
  };
}

describe("answerUnknownSenders", () => {
  it("answers a direct message once, as a reply, with the link", async () => {
    const { tell, sent } = harness();
    await tell(message());
    expect(sent).toEqual([
      { chatId: "D1", text: unknownSenderAnswer(LINK), replyToMessageId: "1.2" },
    ]);
    expect(sent[0]?.text).toContain(LINK);
  });

  it("answers an account again only after 24 hours", async () => {
    const { tell, sent, advance } = harness();
    await tell(message());
    advance(23 * HOUR);
    await tell(message({ messageId: 2 }));
    expect(sent).toHaveLength(1);
    advance(HOUR);
    await tell(message({ messageId: 3 }));
    expect(sent).toHaveLength(2);
  });

  it("answers one of two accounts in a shared chat within 10 minutes", async () => {
    const { tell, sent, advance } = harness();
    const shared = { chatId: "C1" as ChatId, addressing: "mention" as const };
    await tell(message({ ...shared, senderId: "T1/U1" }));
    advance(9 * MINUTE);
    await tell(message({ ...shared, senderId: "T1/U2", messageId: 2 }));
    expect(sent).toHaveLength(1);
    advance(MINUTE);
    await tell(message({ ...shared, senderId: "T1/U2", messageId: 3 }));
    expect(sent).toHaveLength(2);
  });

  it("answers only the sender in a shared chat where the kind offers it", async () => {
    const { tell, sent } = harness({ privately: true });
    await tell(message({ chatId: "C1" as ChatId, addressing: "mention" }));
    expect(sent).toEqual([
      { chatId: "C1", text: unknownSenderAnswer(LINK), onlyTo: "T1/U9", replyToMessageId: "1.2" },
    ]);
  });

  it("answers a direct message as an ordinary reply even where the kind sends privately", async () => {
    const { tell, sent } = harness({ privately: true });
    await tell(message());
    expect(sent[0]?.onlyTo).toBeUndefined();
  });

  it("sends nothing without a public origin", async () => {
    const { tell, sent } = harness({ origin: null });
    await tell(message());
    expect(sent).toEqual([]);
  });

  it("resolves when the send fails or the connection is gone", async () => {
    const { tell, sent } = harness({ fails: true });
    await expect(tell(message())).resolves.toBeUndefined();
    const gone = message({ connectionId: "gone", senderId: "T1/U2", messageId: 2 });
    await expect(tell(gone)).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("forgets the oldest account once the record is full", async () => {
    const { tell, sent } = harness();
    await tell(message({ senderId: "first", chatId: "first" as ChatId }));
    for (let i = 0; i < ANSWERED_KEPT; i++) {
      await tell(message({ senderId: `U${i}`, chatId: `D${i}` as ChatId }));
    }
    expect(sent).toHaveLength(ANSWERED_KEPT + 1);
    await tell(message({ senderId: "first", chatId: "first" as ChatId }));
    expect(sent).toHaveLength(ANSWERED_KEPT + 2);
  });
});
