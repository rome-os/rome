// A channel's send port as an app's hook gets it: whatever the app sends on
// it goes through the chat adapter of the seat at that address and is
// recorded in Chats, as every other send Rome makes is. Contract:
// docs/architecture/channels.md#chat-adapters.

import type {
  Channel,
  ChatId,
  MessageReceipt,
  OutgoingEmailMessage,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import type { ChannelSend } from "./channel.js";
import type { SeatReplies } from "../sessions/seat-replies.js";
import type { ChatRepository } from "../chats/chat-repository.js";
import { addressOf, lineAt, platformIdOfLine, type ChatAdapters } from "../chats/adapter.js";
import { emailOf, type EmailOutbound } from "./email-chat-adapter.js";
import type { MessageRepository } from "../chats/message-repository.js";
import { startChannelChat } from "../chats/open-chat.js";
import { placeIn, type ChatRef } from "../chats/place.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";

export interface RecordedSendsDeps {
  /** Each channel's chat adapter, which names the chat at an address and
   *  sends there. */
  adapters: Pick<ChatAdapters, "of" | "chatAt" | "accountOn" | "addressAt" | "keyOf">;
  chats: Pick<ChatRepository, "byKey" | "start">;
  webchatRepo: Pick<WebChatRepository, "seatIn" | "seatInThread" | "seatOf">;
  replies: Pick<SeatReplies, "send">;
  messages: Pick<MessageRepository, "send" | "idOf">;
}

/**
 * `channels` with each send port saying what is sent through the account's
 * chat adapter, and recording it: through the seat that heard the address,
 * else in the chat Rome holds there, started when it holds none, with no
 * session opened. The dashboard records its own lines. An email is a message
 * in its thread's chat, and one that names no thread opens one.
 */
export function recordedSends<C extends Channel>(
  channels: readonly C[],
  deps: RecordedSendsDeps,
): C[] {
  return channels.map((channel) => {
    const send = channel.send as ChannelSend | null | undefined;
    if (!send || channel.name === "webchat") return channel;
    const wrapped = Object.create(send) as ChannelSend;
    Object.defineProperty(wrapped, "send", {
      value: async (address: ChatId, message: OutgoingMessage): Promise<MessageReceipt> => {
        const email = message.kind === "email" ? message : undefined;
        const out: Omit<EmailOutbound, "replyTo"> = {
          text: message.text ?? "",
          ...(message.parts?.length ? { parts: message.parts } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(email?.html ? { html: email.html } : {}),
        };
        // The port quotes by the platform's id, an email by the provider's.
        const quoted = email?.inReplyToMessageId ?? message.replyToMessageId;
        if (email && !address.trim()) return await openThread(deps, channel, out, email);
        const seat = seatAt(deps, channel.name, address);
        const platformMessageId = seat
          ? await sayInSeat(deps, channel, seat, out, message, quoted)
          : await sayInChat(deps, channel, address, out, message, quoted);
        return { chatId: address, ...(platformMessageId ? { messageId: platformMessageId } : {}) };
      },
    });
    return { ...channel, send: wrapped } as C;
  });
}

/**
 * The seat channel `channel`'s account holds in the chat at `address`, by its
 * session's id, or null when it holds none: the group the address names, else
 * the direct message there, else the thread the address names.
 */
function seatAt(deps: RecordedSendsDeps, channel: string, address: ChatId): string | null {
  const account = deps.adapters.accountOn(channel).id;
  for (const kind of ["group", "dm"] as const) {
    const chat = deps.chats.byKey(deps.adapters.chatAt(channel, address, kind));
    const seat = chat && deps.webchatRepo.seatIn(chat.ref.id, null, account);
    if (seat) return seat;
  }
  return deps.webchatRepo.seatInThread(address, account);
}

/** Say `out` through seat `sessionId`, which heard the address. Throws when
 *  the seat stands in no chat, rather than sending a line nobody can read
 *  back. */
async function sayInSeat(
  deps: RecordedSendsDeps,
  channel: Channel,
  sessionId: string,
  out: Omit<EmailOutbound, "replyTo">,
  message: OutgoingMessage,
  quoted: string | undefined,
): Promise<string | null> {
  const seat = await deps.webchatRepo.seatOf(sessionId);
  if (!seat) throw new Error(`Session ${sessionId} stands in no chat to send in`);
  const key = deps.adapters.keyOf(seat.place.chat);
  const replyTo = quoted ? quoteIn(deps, seat.place.chat, lineAt(key, seat.accountId, quoted)) : {};
  const said = await deps.replies.send(
    sessionId,
    channel,
    { ...out, ...replyTo },
    message.turnId ? { turnId: message.turnId } : {},
  );
  if (!said) throw new Error(`Session ${sessionId} stands in no chat to send in`);
  return platformIdOfLine(key, seat.accountId, said.sent);
}

/**
 * Say `out` at an address no seat of the account heard: in the chat Rome
 * holds there, started when it holds none, as Rome's main agent. No session
 * opens, since no agent is in the chat until a message there wakes one. A
 * group Rome holds is named by its address; anything else at an address is a
 * direct message.
 */
async function sayInChat(
  deps: RecordedSendsDeps,
  channel: Channel,
  address: ChatId,
  out: Omit<EmailOutbound, "replyTo">,
  message: OutgoingMessage,
  quoted: string | undefined,
): Promise<string | null> {
  const account = deps.adapters.accountOn(channel.name);
  const platform = account.platform;
  const adapter = deps.adapters.of(channel);
  // The port names a thread by its address alone; the adapter knows the
  // thread's chat once it has heard the thread.
  const threadOf = adapter.threadAt(address);
  const group =
    threadOf !== null ||
    message.kind === "email" ||
    deps.chats.byKey(deps.adapters.chatAt(channel.name, address, "group"))?.kind === "group";
  const { chat, key, romeEnd } = startChannelChat(deps, {
    channel: channel.name,
    threadId: address,
    ...(threadOf ? { parentThreadId: addressOf(threadOf) } : {}),
    threadType: group ? "group" : "private",
  });
  const thread = threadOf ? address : null;
  const replyTo = quoted ? quoteIn(deps, chat, lineAt(key, romeEnd, quoted)) : {};
  let lineKey: string | null = null;
  await deps.messages.send(
    {
      direction: "fromRome",
      place: placeIn(chat, thread ?? undefined),
      saidBy: { account: { platform, id: romeEnd }, agent: "main" },
      parts: out.parts ?? [{ type: "text", content: out.text }],
      ...replyTo,
    },
    async (target) => {
      lineKey = await adapter.send(target.chat, thread, {
        ...out,
        ...(target.replyTo ? { replyTo: target.replyTo } : {}),
      });
      return { key: lineKey };
    },
  );
  return lineKey === null ? null : platformIdOfLine(key, romeEnd, lineKey);
}

/** The quote of the line keyed `key` in `chat`: by its id when Rome holds
 *  it, else by its key, which the platform still shows as quoted. */
function quoteIn(
  deps: Pick<RecordedSendsDeps, "messages">,
  chat: ChatRef,
  key: string,
): { replyTo: number | { key: string } } {
  return { replyTo: deps.messages.idOf(chat, key) ?? { key } };
}

/**
 * Open a thread for `email`, which names none, and say `out` there as Rome's
 * main agent: its first message, which starts it. No session opens, as for
 * any send at an address no seat heard.
 */
async function openThread(
  deps: RecordedSendsDeps,
  channel: Channel,
  out: Omit<EmailOutbound, "replyTo">,
  email: OutgoingEmailMessage,
): Promise<MessageReceipt> {
  const adapter = emailOf(deps.adapters, channel);
  const subject = email.subject?.trim() || null;
  const key = adapter.open(
    {
      to: email.to ?? [],
      ...(email.cc ? { cc: email.cc } : {}),
      ...(email.bcc ? { bcc: email.bcc } : {}),
    },
    subject ?? "",
  );
  const chat = deps.chats.start(key, "group", subject).ref;
  const romeEnd = adapter.account.id;
  let lineKey = "";
  await deps.messages.send(
    {
      direction: "fromRome",
      place: placeIn(chat),
      saidBy: { account: { platform: chat.platform, id: romeEnd }, agent: "main" },
      parts: out.parts ?? [{ type: "text", content: out.text }],
    },
    async (target) => {
      lineKey = await adapter.send(target.chat, null, out);
      return { key: lineKey };
    },
  );
  const messageId = platformIdOfLine(key, romeEnd, lineKey);
  return {
    chatId: deps.adapters.addressAt(channel.name, placeIn(chat)),
    ...(messageId ? { messageId } : {}),
  };
}
