// A channel's send port as an app's hook gets it: whatever the app sends on
// it goes through the chat adapter of the seat at that address and is
// recorded in Chats, as every other send Rome makes is. Contract:
// docs/architecture/channels.md#chat-adapters.
//
// Nothing wraps the channels with this yet: the Chats switch does.

import type {
  Channel,
  ChatId,
  MessageReceipt,
  OutgoingEmailMessage,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import type { ChannelSend } from "../channels/channel.js";
import type { ChatRepository } from "../chats/storage/chat-repository.js";
import { partsText } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn, type ChatRef, type Place } from "../chats/storage/place.js";
import { htmlToMarkdown } from "../lib/email-markdown.js";
import type { SeatReplies } from "../sessions/seat-replies.js";
import type { MessagePart } from "../types.js";
import type { Seats } from "../sessions/seats.js";
import { startChannelChat } from "./channel-chat.js";
import {
  addressOf,
  lineAt,
  namesGroup,
  platformIdOfLine,
  type ChatAdapters,
} from "./chat-adapter.js";
import {
  EMAIL_PLATFORM,
  emailOf,
  isEmailAdapter,
  type EmailOutbound,
} from "./email-chat-adapter.js";

export interface RecordedSendsDeps {
  /** Each channel's chat adapter, which names the chat at an address and
   *  sends there. */
  adapters: Pick<ChatAdapters, "of" | "chatAt" | "accountOn" | "addressAt" | "keyOf">;
  chats: Pick<ChatRepository, "byKey" | "start">;
  seats: Pick<Seats, "seatOf" | "seatIn" | "seatInThread">;
  replies: Pick<SeatReplies, "send">;
  messages: Pick<MessageRepository, "send" | "idOf" | "chatHolding">;
}

type Out = Omit<EmailOutbound, "replyTo">;

/** Where a send landed, as its receipt names it: the address, and the
 *  platform's id for the message when it gave one. */
interface Landed {
  readonly address: ChatId;
  readonly messageId: string | null;
}

/**
 * `out` as it goes on record: its parts, else its text, else the text of
 * its HTML, with a note for each attachment, which Chats keeps no file of.
 */
function recordedParts(out: Out): MessagePart[] {
  const notes = (out.attachments ?? []).map(
    (attachment) => `[${attachment.type}${attachment.caption ? `: ${attachment.caption}` : ""}]`,
  );
  if (out.parts?.length) {
    return notes.length
      ? [...out.parts, { type: "text", content: notes.join("\n") }]
      : [...out.parts];
  }
  const text = out.text.trim() || (out.html ? htmlToMarkdown(out.html).trim() : "");
  return [{ type: "text", content: [text, ...notes].filter(Boolean).join("\n") }];
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
        const local = threadsStartedOn(deps, channel);
        const email = message.kind === "email" ? message : undefined;
        const out: Out = {
          // The port reads a message without text by its parts.
          text: message.text ?? (message.parts ? partsText(message.parts) : ""),
          ...(message.parts?.length ? { parts: message.parts } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(email?.html ? { html: email.html } : {}),
          ...(email?.cc?.length ? { cc: email.cc } : {}),
          ...(email?.bcc?.length ? { bcc: email.bcc } : {}),
        };
        if (!email && sendsNoEmail(deps, channel.name, message)) {
          // The email port sends nothing for a plain message with no text,
          // such as an approval card, which has no email rendering.
          return { chatId: address };
        }
        // The port quotes by the platform's id, an email by the provider's.
        const quoted = email?.inReplyToMessageId ?? message.replyToMessageId;
        let at = address;
        if (!email && namesNewEmail(local, channel.name, address)) {
          // The email port takes a plain message to an address, or to the
          // guardian, as a new email to them.
          return await openThread(local, channel, out, {
            kind: "email",
            ...message,
            to: address,
          } as OutgoingEmailMessage);
        }
        if (email?.inReplyToMessageId) {
          // The provider sends a reply into the thread of the email it
          // answers, whatever address it names, so it is recorded there.
          // Rome must know that email to know the thread.
          const answered = threadOf(local, channel.name, email.inReplyToMessageId);
          if (!answered) {
            throw new Error(
              `Rome holds no email ${email.inReplyToMessageId} to reply to. No email was sent.`,
            );
          }
          at = answered;
        } else if (email && !address.trim()) {
          return await openThread(local, channel, out, email);
        }
        const seat = seatAt(local, channel.name, at);
        const landed = seat
          ? await sayInSeat(local, channel, seat, out, message, quoted)
          : await sayInChat(local, channel, at, out, message, quoted);
        return {
          chatId: landed.address,
          ...(landed.messageId ? { messageId: landed.messageId } : {}),
        };
      },
    });
    return { ...channel, send: wrapped } as C;
  });
}

/**
 * `deps` with the chat at an address on `channel` also read from the threads
 * its email adapter started, which it keeps even when storing a thread's
 * address failed, so a send to that thread reaches the chat Rome opened.
 */
function threadsStartedOn(deps: RecordedSendsDeps, channel: Channel): RecordedSendsDeps {
  if (deps.adapters.accountOn(channel.name).platform !== EMAIL_PLATFORM) return deps;
  const adapter = deps.adapters.of(channel);
  if (!isEmailAdapter(adapter)) return deps;
  const { adapters } = deps;
  return {
    ...deps,
    adapters: {
      of: (of) => adapters.of(of),
      accountOn: (name) => adapters.accountOn(name),
      addressAt: (name, place) =>
        name === channel.name && place.threadId === undefined
          ? adapter.threadAddress(adapters.keyOf(place.chat).externalId)
          : adapters.addressAt(name, place),
      keyOf: (ref) => adapters.keyOf(ref),
      chatAt: (name, address, kind) =>
        (name === channel.name ? adapter.chatStartedAt(address) : null) ??
        adapters.chatAt(name, address, kind),
    },
  };
}

/** Whether `message` is a plain message the email port on channel
 *  `channel` sends nothing for: one with no text and no attachment. */
function sendsNoEmail(deps: RecordedSendsDeps, channel: string, message: OutgoingMessage): boolean {
  if (deps.adapters.accountOn(channel).platform !== EMAIL_PLATFORM) return false;
  // The port refuses an attachment before it reads the body.
  if (message.attachments?.length) return false;
  const text =
    message.text ??
    (message.parts ?? []).flatMap((part) => (part.type === "text" ? [part.content] : [])).join("");
  return !text.trim();
}

/** Whether `address` on channel `channel` names whom a new email goes to:
 *  an email address, bare or with a display name, or the guardian, where
 *  Rome holds no thread. The email port reads an address the same way. */
function namesNewEmail(deps: RecordedSendsDeps, channel: string, address: string): boolean {
  if (deps.adapters.accountOn(channel).platform !== EMAIL_PLATFORM) return false;
  const named = address.trim().toLowerCase() === "guardian" || address.includes("@");
  return named && !deps.chats.byKey(deps.adapters.chatAt(channel, address, "group"));
}

/** The address of the email thread that holds the email the provider calls
 *  `messageId`, or null when Rome holds no such email. */
function threadOf(deps: RecordedSendsDeps, channel: string, messageId: string): ChatId | null {
  const account = deps.adapters.accountOn(channel);
  const chat = deps.messages.chatHolding(account.platform, messageId);
  return chat ? deps.adapters.addressAt(channel, placeIn(chat)) : null;
}

/**
 * The seat channel `channel`'s account holds in the chat at `address`, by its
 * session's id, or null when it holds none: the group the address names, else
 * the direct message there, else the thread the address names.
 */
function seatAt(deps: RecordedSendsDeps, channel: string, address: ChatId): string | null {
  const account = deps.adapters.accountOn(channel);
  for (const kind of ["group", "dm"] as const) {
    const chat = deps.chats.byKey(deps.adapters.chatAt(channel, address, kind));
    const seat = chat && deps.seats.seatIn(chat.ref.id, null, account.id);
    if (seat) return seat;
  }
  return deps.seats.seatInThread(address, account);
}

/** Say `out` through seat `sessionId`, which heard the address. Throws when
 *  the seat stands in no chat, rather than sending a line nobody can read
 *  back. */
async function sayInSeat(
  deps: RecordedSendsDeps,
  channel: Channel,
  sessionId: string,
  out: Out,
  message: OutgoingMessage,
  quoted: string | undefined,
): Promise<Landed> {
  const seat = deps.seats.seatOf(sessionId);
  if (!seat) throw new Error(`Session ${sessionId} stands in no chat to send in`);
  const key = deps.adapters.keyOf(seat.place.chat);
  const replyTo = quoted ? quoteIn(deps, seat.place.chat, lineAt(key, seat.accountId, quoted)) : {};
  const said = await deps.replies.send(
    sessionId,
    channel,
    { ...out, ...replyTo },
    { recorded: recordedParts(out), ...(message.turnId ? { turnId: message.turnId } : {}) },
  );
  if (!said) throw new Error(`Session ${sessionId} stands in no chat to send in`);
  return {
    // Where the platform placed it, whether or not the record landed.
    address: deps.adapters.addressAt(
      channel.name,
      placeIn(seat.place.chat, said.landedIn ?? undefined),
    ),
    messageId: platformIdOfLine(key, seat.accountId, said.sent),
  };
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
  out: Out,
  message: OutgoingMessage,
  quoted: string | undefined,
): Promise<Landed> {
  const account = deps.adapters.accountOn(channel.name);
  const adapter = deps.adapters.of(channel);
  // The port names a thread by its address alone; the adapter knows the
  // thread's chat once it has heard the thread.
  const threadOf = adapter.threadAt(address);
  const group =
    threadOf !== null ||
    // Every email thread is a group, whether or not the message says email.
    account.platform === EMAIL_PLATFORM ||
    message.kind === "email" ||
    namesGroup(account.platform, address) ||
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
  let landedIn: Place = placeIn(chat, thread ?? undefined);
  await deps.messages.send(
    {
      direction: "fromRome",
      place: landedIn,
      saidBy: { account: { platform: account.platform, id: romeEnd }, agent: "main" },
      parts: recordedParts(out),
      ...replyTo,
    },
    async (target) => {
      const sent = await adapter.send(target.chat, thread, {
        ...out,
        ...(target.replyTo ? { replyTo: target.replyTo } : {}),
        ...(message.turnId ? { turnId: message.turnId } : {}),
      });
      lineKey = sent.key;
      landedIn = placeIn(chat, sent.threadId ?? undefined);
      return {
        key: sent.key,
        ...(sent.threadId === thread ? {} : { landedIn: { threadId: sent.threadId } }),
      };
    },
  );
  return {
    // The adapter keeps the address a direct message landed at.
    address: deps.adapters.addressAt(channel.name, landedIn),
    messageId: lineKey === null ? null : platformIdOfLine(key, romeEnd, lineKey),
  };
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
  out: Out,
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
      parts: recordedParts(out),
    },
    async (target) => {
      lineKey = (
        await adapter.send(target.chat, null, {
          ...out,
          ...(email.turnId ? { turnId: email.turnId } : {}),
        })
      ).key;
      return { key: lineKey };
    },
  );
  const messageId = platformIdOfLine(key, romeEnd, lineKey);
  return {
    // The adapter keeps the provider's thread even when storing it failed.
    chatId: adapter.threadAddress(key.externalId),
    ...(messageId ? { messageId } : {}),
  };
}
