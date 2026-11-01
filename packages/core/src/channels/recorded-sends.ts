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
import { lineAt, platformIdOfLine, type ChatAdapters } from "../chats/adapter.js";
import type { EmailOutbound } from "./email-chat-adapter.js";
import type { MessageRepository } from "../chats/message-repository.js";
import { startChannelChat } from "../chats/open-chat.js";
import { placeIn } from "../chats/place.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";

export interface RecordedSendsDeps {
  /** Each channel's chat adapter, which names the chat at an address and
   *  sends there. */
  adapters: Pick<ChatAdapters, "of" | "emailOf" | "chatAt" | "accountOn" | "addressAt">;
  chats: Pick<ChatRepository, "get" | "start">;
  webchatRepo: Pick<WebChatRepository, "seatIn" | "seatInThread" | "seatOf">;
  replies: Pick<SeatReplies, "send">;
  messages: Pick<MessageRepository, "send">;
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
        const out: EmailOutbound = {
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
    const chat = deps.adapters.chatAt(channel, address, kind);
    const seat = deps.webchatRepo.seatIn(chat.id, null, account);
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
  out: EmailOutbound,
  message: OutgoingMessage,
  quoted: string | undefined,
): Promise<string | null> {
  const seat = await deps.webchatRepo.seatOf(sessionId);
  if (!seat) throw new Error(`Session ${sessionId} stands in no chat to send in`);
  const replyTo = quoted ? lineAt(seat.place.chat, seat.accountId, quoted) : undefined;
  const said = await deps.replies.send(
    sessionId,
    channel,
    { ...out, ...(replyTo ? { replyTo } : {}) },
    message.turnId ? { turnId: message.turnId } : {},
  );
  if (!said) throw new Error(`Session ${sessionId} stands in no chat to send in`);
  return platformIdOfLine(seat.place.chat, seat.accountId, said.sent);
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
  out: EmailOutbound,
  message: OutgoingMessage,
  quoted: string | undefined,
): Promise<string | null> {
  const account = deps.adapters.accountOn(channel.name);
  const platform = account.platform;
  const group =
    message.kind === "email" ||
    deps.chats.get(deps.adapters.chatAt(channel.name, address, "group"))?.kind === "group";
  const { chat, romeEnd } = startChannelChat(deps, {
    channel: channel.name,
    threadId: address,
    threadType: group ? "group" : "private",
  });
  const adapter = deps.adapters.of(channel);
  const replyTo = quoted ? lineAt(chat, romeEnd, quoted) : undefined;
  let lineId: string | null = null;
  await deps.messages.send(
    {
      direction: "fromRome",
      place: placeIn(chat),
      saidBy: { account: { platform, id: romeEnd }, agent: "main" },
      parts: out.parts ?? [{ type: "text", content: out.text }],
      ...(replyTo ? { replyTo } : {}),
    },
    async () => {
      lineId = await adapter.send(chat.id, null, { ...out, ...(replyTo ? { replyTo } : {}) });
      return { id: lineId };
    },
  );
  return lineId === null ? null : platformIdOfLine(chat, romeEnd, lineId);
}

/**
 * Open a thread for `email`, which names none, and say `out` there as Rome's
 * main agent: its first message, which starts it. No session opens, as for
 * any send at an address no seat heard.
 */
async function openThread(
  deps: RecordedSendsDeps,
  channel: Channel,
  out: EmailOutbound,
  email: OutgoingEmailMessage,
): Promise<MessageReceipt> {
  const adapter = deps.adapters.emailOf(channel);
  const subject = email.subject?.trim() || null;
  const chat = adapter.open(
    {
      to: email.to ?? [],
      ...(email.cc ? { cc: email.cc } : {}),
      ...(email.bcc ? { bcc: email.bcc } : {}),
    },
    subject ?? "",
  );
  deps.chats.start(chat, "group", subject);
  const romeEnd = adapter.account.id;
  let lineId = "";
  await deps.messages.send(
    {
      direction: "fromRome",
      place: placeIn(chat),
      saidBy: { account: { platform: chat.platform, id: romeEnd }, agent: "main" },
      parts: out.parts ?? [{ type: "text", content: out.text }],
    },
    async () => {
      lineId = await adapter.send(chat.id, null, out);
      return { id: lineId };
    },
  );
  const messageId = platformIdOfLine(chat, romeEnd, lineId);
  return {
    chatId: deps.adapters.addressAt(channel.name, placeIn(chat)),
    ...(messageId ? { messageId } : {}),
  };
}
