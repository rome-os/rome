// Type checks on the message refactor's layering, checked by `tsc`: a broken
// assertion fails the type check, and the test below only keeps the file in
// the unit suite. Vocabulary: docs/domains/connections.md#message,
// docs/domains/participation.md#addressed.

import type { Attachment, ChannelMessage } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import type { Message as ChatsMessage } from "../chats/storage/message.js";
import type { Talker } from "../connections/types.js";
import type { DiscordAdapter } from "../connections/kinds/discord/discord.js";
import type { EmailAdapter } from "../connections/kinds/email/email.js";
import type { FeishuAdapter } from "../connections/kinds/feishu/feishu.js";
import type { SlackAdapter } from "../connections/kinds/slack/slack.js";
import type { TelegramAdapter } from "../connections/kinds/telegram/telegram.js";
import type { TelegramUserAdapter } from "../connections/kinds/telegram-user/telegram-user.js";
import type { WechatAdapter } from "../connections/kinds/wechat/wechat.js";
import type { WhatsAppAdapter } from "../connections/kinds/whatsapp/whatsapp.js";
import type { Message } from "../connections/message.js";
import { type Addressed, addressing } from "../participation/addressing.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
/** The same set of keys or literals, each side assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function holds<_T extends true>(): void {}

/** The fields a message would carry if a layer had decided them. */
type Decided = "addressing" | "fromBot" | "mentionsOthers" | "person";

/** Every key of `T`, at any depth. */
type DeepKeys<T> = T extends Date | Attachment | readonly unknown[]
  ? never
  : T extends object
    ? { [K in keyof T]-?: K | DeepKeys<NonNullable<T[K]>> }[keyof T]
    : never;

/** Every value at the end of `T`'s fields, leaving out attachments and the platform's own payload. */
type Leaves<T> = T extends Date | string | number | boolean
  ? T
  : T extends readonly unknown[]
    ? Leaves<T[number]>
    : T extends object
      ? { [K in Exclude<keyof T, "attachments" | "raw">]-?: Leaves<NonNullable<T[K]>> }[Exclude<
          keyof T,
          "attachments" | "raw"
        >]
      : never;

type InboundOf<A> = A extends { onInbound(handler: (message: infer M) => Promise<void>): void }
  ? M
  : never;
type DeliveredBy<T> = T extends {
  start(deliver: (message: infer M) => void, ...rest: never[]): void;
}
  ? M
  : never;

// (e) Neither message carries a decision, at any depth.
holds<Equals<Extract<DeepKeys<Message>, Decided>, never>>();
holds<Equals<Extract<DeepKeys<ChatsMessage>, Decided>, never>>();

// (f) The connection's message holds platform facts only: strings, the time,
// and flags, with no Chats or People type such as a place, a ref or a person.
holds<Equals<Leaves<Message> extends string | boolean | Date ? true : false, true>>();
holds<Equals<Extract<DeepKeys<Message>, "place" | "ref" | "chatRef" | "messageRef">, never>>();

// (g) Addressing answers with the closed union, nothing wider.
holds<Equals<ReturnType<typeof addressing>, Addressed>>();
holds<Equals<Addressed, "rome" | "others" | "nobody">>();

// (h) Every kind hands over the connection's message, and so does a Talker.
holds<Equals<InboundOf<DiscordAdapter>, Message>>();
holds<Equals<InboundOf<EmailAdapter>, Message>>();
holds<Equals<InboundOf<FeishuAdapter>, Message>>();
holds<Equals<InboundOf<SlackAdapter>, Message>>();
holds<Equals<InboundOf<TelegramAdapter>, Message>>();
holds<Equals<InboundOf<TelegramUserAdapter>, Message>>();
holds<Equals<InboundOf<WechatAdapter>, Message>>();
holds<Equals<InboundOf<WhatsAppAdapter>, Message>>();
holds<Equals<DeliveredBy<Talker>, Message>>();

// What apps receive keeps every field it had, the decisions included.
holds<
  Same<
    keyof ChannelMessage,
    | "channel"
    | "account"
    | "direction"
    | "messageId"
    | "chatId"
    | "parentChatId"
    | "senderId"
    | "senderDisplayName"
    | "senderUsername"
    | "text"
    | "attachments"
    | "timestamp"
    | "replyTo"
    | "thread"
    | "chatThread"
    | "addressing"
    | "fromBot"
    | "mentionsOthers"
    | "raw"
    | "ref"
    | "cursor"
  >
>();

describe("message types", () => {
  it("are checked by the type check", () => {
    expect(addressing({ where: { kind: "direct" } }, "rome")).toBe("rome");
  });
});
