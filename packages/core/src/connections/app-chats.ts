// What an app's `deps.chats` reaches: sends into the places Chats names, and
// the chats an app resolves an intent to. Vocabulary: docs/domains/chats.md
// and the SDK's `@rome-os/app-runtime/chats`.
//
// A send goes the way every send Rome makes goes: through the speaker of the
// sending account in that place when one stands there, so it is recorded as
// that speaker's agent, else through the account's chat adapter as Rome's
// main agent, recorded once the platform took it. Nothing here guesses a
// destination: a place is a ref Chats handed out, and a direct message is
// opened only by `dm`, through the channel's own direct messaging.
//
// Nothing wires this to apps yet: the Chats switch does, once chats are
// named by Chats' ids.

import {
  type Account,
  type Channel,
  type ChatId,
  isChannelSendRefused,
} from "@rome-os/app-runtime";
import {
  type ChatMessage,
  type ChatRef as SdkChatRef,
  type ChatsPort,
  chatOf,
  isThreadRef,
  type Place as SdkPlace,
  SendError,
  type SendOptions,
  type Sent as SdkSent,
} from "@rome-os/app-runtime/chats";
import { ChannelNotConnected, type ChannelSend } from "../channels/channel.js";
import { DeliveryFailure } from "../channels/delivery/types.js";
import { withoutHostOnlyParts } from "../channels/host-only-parts.js";
import type { Chat } from "../chats/storage/chat.js";
import type { ChatRepository } from "../chats/storage/chat-repository.js";
import { partsText } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn, type Place } from "../chats/storage/place.js";
import { DASHBOARD_PLATFORM } from "../chats/send.js";
import { createLogger } from "../logger.js";
import type { SpeakerReplies } from "../sessions/speaker-replies.js";
import type { Speakers } from "../sessions/speakers.js";
import type { MessagePart } from "../types.js";
import { type ChatAdapters, platformIdOfLine } from "./chat-adapter.js";
import { type ChatKey, directMessageOn } from "./chat-ids.js";

const log = createLogger("app-chats");

export interface AppChatsDeps {
  /** The channels Rome has now, each one of Rome's accounts. */
  channels(): readonly Channel[];
  /** The channels of Rome's accounts on `platform`. */
  channelsOn(platform: string): readonly string[];
  adapters: Pick<ChatAdapters, "of" | "accountOn" | "channelOf" | "keyOf" | "directMessageReached">;
  chats: Pick<ChatRepository, "get" | "byKey" | "start" | "list">;
  speakers: Pick<Speakers, "speakerIn">;
  replies: Pick<SpeakerReplies, "send">;
  messages: Pick<MessageRepository, "send" | "byIds" | "idOf">;
}

/** The SDK's {@link ChatsPort} over Chats, its adapters and Agents' speakers. */
export function appChats(deps: AppChatsDeps): ChatsPort {
  return {
    send: (place, out, opts) => send(deps, place, out, opts),
    dm: (account, opts) => dm(deps, account, opts),
    group: async (query) => group(deps, query),
  };
}

/** One of Rome's accounts, with the channel it speaks through. */
interface Sender {
  readonly account: Account;
  readonly channel: Channel;
}

async function send(
  deps: AppChatsDeps,
  place: SdkPlace,
  out: ChatMessage,
  opts: SendOptions | undefined,
): Promise<SdkSent> {
  const chat = heldChat(deps, chatOf(place));
  const { at, anchor } = placeOf(deps, chat, place);
  const replyTo = replyOf(chat, out, anchor?.id);
  const sender = senderIn(deps, chat, at, opts?.as);
  // Read before delivery: nothing after the platform took the message may
  // fail the send.
  const key = deps.adapters.keyOf(chat.ref);
  if (anchor && platformIdOfLine(key, sender.account.id, anchor.key) === null) {
    // The adapter drops a quote it cannot address, which would post to the
    // open chat instead of the thread asked for.
    throw new SendError(
      "unsupported",
      `${describe(sender.account)} cannot answer message ${anchor.id}, so it cannot open its thread`,
    );
  }
  const given = out.parts?.length ? withoutHostOnlyParts(out.parts) : [];
  const parts = recordedParts(out, given);
  // A message with no words, such as a card, goes to the adapter as it is:
  // one that cannot show it refuses it, and so does one given nothing.
  const text = out.text ?? partsText(given);
  const outbound = {
    text,
    ...(given.length ? { parts: given } : {}),
    ...(out.attachments?.length ? { attachments: out.attachments } : {}),
  };

  const speaker = deps.speakers.speakerIn(chat.ref.id, at.threadId ?? null, sender.account.id);
  const delivered = await deliverAs(sender, async () => {
    if (speaker) {
      const said = await deps.replies.send(
        speaker,
        sender.channel,
        { ...outbound, ...(replyTo === undefined ? {} : { replyTo }) },
        { recorded: parts },
      );
      if (said) return { id: said.id, lineKey: said.sent, landedIn: said.landedIn, at: said.at };
    }
    const adapter = deps.adapters.of(sender.channel);
    let lineKey = "";
    let landedIn: ChatId | null = at.threadId ?? null;
    const sent = await deps.messages.send(
      {
        direction: "fromRome",
        place: at,
        saidBy: { account: sender.account, agent: "main" },
        parts,
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      async (target) => {
        const delivered = await adapter.send(target.chat, at.threadId ?? null, {
          ...outbound,
          ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
        });
        lineKey = delivered.key;
        landedIn = delivered.threadId;
        return {
          key: delivered.key,
          ...(delivered.threadId === (at.threadId ?? null)
            ? {}
            : { landedIn: { threadId: delivered.threadId } }),
        };
      },
    );
    return { id: sent.id, lineKey, landedIn, at: sent.at };
  });
  return sentOf(deps, chat, key, sender, delivered);
}

/** What a delivery answers: the line's id in Chats, or null when it is not on
 *  record, its adapter's key, and the thread it landed in. */
interface Delivered {
  readonly id: number | null;
  readonly lineKey: string;
  readonly landedIn: ChatId | null;
  readonly at: Date;
}

/** `deliver`, with a failure to reach the platform answered as the SDK's
 *  refusal. */
async function deliverAs(sender: Sender, deliver: () => Promise<Delivered>): Promise<Delivered> {
  try {
    return await deliver();
  } catch (error) {
    if (error instanceof SendError) throw error;
    if (isChannelSendRefused(error)) throw new SendError("unsupported", error.message);
    if (
      error instanceof ChannelNotConnected ||
      (error instanceof DeliveryFailure && error.kind === "unauthorized")
    ) {
      throw new SendError("not_connected", `No Connection reaches ${describe(sender.account)} now`);
    }
    throw new SendError("failed", error instanceof Error ? error.message : String(error));
  }
}

/** The chat `ref` names, or a refusal when Rome holds none, or one Rome does
 *  not send into through an app. */
function heldChat(deps: AppChatsDeps, ref: SdkChatRef): Chat {
  const chat = deps.chats.get(ref);
  if (!chat) throw new SendError("chat_not_found", `No ${ref.platform} chat ${ref.id}`);
  if (chat.ref.platform === DASHBOARD_PLATFORM) {
    throw new SendError("unsupported", "An app does not send into a dashboard chat");
  }
  return chat;
}

/**
 * Where a send to `place` goes in `chat`. A thread is named by a message of
 * it: the thread that message was said in, else the thread that hangs off
 * it, which the send opens by answering it where the platform threads its
 * answers.
 */
function placeOf(
  deps: AppChatsDeps,
  chat: Chat,
  place: SdkPlace,
): { at: Place; anchor?: { id: number; key: string } } {
  if (!isThreadRef(place)) return { at: placeIn(chat.ref) };
  const [message] = deps.messages.byIds([place.id]);
  if (!message || message.place.chat.id !== chat.ref.id) {
    throw new SendError("chat_not_found", `No message ${place.id} in that chat to thread off`);
  }
  if (message.place.threadId !== undefined) return { at: message.place };
  return { at: placeIn(chat.ref), anchor: { id: message.id, key: message.key } };
}

/**
 * The message a send answers, by its id, which has to be in `chat`: the one
 * `out` quotes, else `anchor`, the message whose thread it opens. A send that
 * opens a thread answers that message, since the platform picks the thread by
 * the message answered, so a quote of another is refused.
 */
function replyOf(chat: Chat, out: ChatMessage, anchor: number | undefined): number | undefined {
  if (out.replyTo === undefined) return anchor;
  const { chat: quoted, id } = out.replyTo;
  if (quoted.platform !== chat.ref.platform || quoted.id !== chat.ref.id) {
    throw new SendError("chat_not_found", "A reply quotes a message of the chat it is sent in");
  }
  if (anchor !== undefined && id !== anchor) {
    throw new SendError(
      "unsupported",
      "A send that opens a thread off a message quotes that message, not another",
    );
  }
  return id;
}

/**
 * The one of Rome's accounts a send to `at` in `chat` goes out as: `as` when
 * it is named, else Rome's end of a direct message, else the one account
 * that speaks in that place, else Rome's only account on the platform.
 */
function senderIn(deps: AppChatsDeps, chat: Chat, at: Place, as: Account | undefined): Sender {
  const platform = chat.ref.platform;
  const romeEnd = romeEndOf(deps, chat);
  if (as) {
    if (as.platform !== platform || (romeEnd !== null && romeEnd !== as.id)) {
      throw new SendError("sender_not_in_chat", `${describe(as)} is not in that chat`);
    }
    return senderAs(deps, as);
  }
  const accounts = deps.channelsOn(platform).map((name) => deps.adapters.accountOn(name));
  if (romeEnd !== null) return senderAs(deps, { platform, id: romeEnd }, { inferred: true });
  const speaking = accounts.filter(
    (account) => deps.speakers.speakerIn(chat.ref.id, at.threadId ?? null, account.id) !== null,
  );
  const [only] = speaking.length === 1 ? speaking : accounts.length === 1 ? accounts : [];
  if (only) return senderAs(deps, only, { inferred: true });
  if (accounts.length === 0) {
    throw new SendError("not_connected", `Rome holds no account on ${platform}`);
  }
  throw new SendError(
    "sender_ambiguous",
    `Rome holds ${accounts.length} accounts on ${platform}; name one as \`as\``,
  );
}

/** Rome's end of the direct message `chat` is, which its key names, or null
 *  for a group or a key that names no end. */
function romeEndOf(deps: AppChatsDeps, chat: Chat): string | null {
  if (chat.kind !== "dm") return null;
  const match = /^dm:([^:]+):/.exec(deps.adapters.keyOf(chat.ref).externalId);
  return match?.[1] ?? null;
}

/** Rome's account `account`, with the channel it speaks through now. An
 *  `inferred` account is the chat's own, so one no channel holds is not
 *  connected rather than a wrong pick. */
function senderAs(deps: AppChatsDeps, account: Account, opts?: { inferred: boolean }): Sender {
  const name = deps.adapters.channelOf(account);
  if (name === null) {
    if (opts?.inferred) {
      throw new SendError("not_connected", `No Connection reaches ${describe(account)}`);
    }
    throw new SendError("sender_not_in_chat", `Rome holds no account ${describe(account)}`);
  }
  const channel = deps.channels().find((candidate) => candidate.name === name);
  if (!channel) throw new SendError("not_connected", `No Connection reaches ${describe(account)}`);
  if (!channel.send) {
    throw new SendError("unsupported", `${describe(account)} takes no sends from Rome`);
  }
  return { account, channel };
}

/**
 * The SDK's answer for a message the platform took, which never throws:
 * reporting a sent message as failed invites a second one. A record that did
 * not land is logged and answered by the id Rome holds for the line, if any.
 */
function sentOf(
  deps: AppChatsDeps,
  chat: Chat,
  key: ChatKey,
  sender: Sender,
  { id, lineKey, landedIn, at }: Delivered,
): SdkSent {
  let recorded = id;
  if (recorded === null) {
    try {
      recorded = deps.messages.idOf(chat.ref, lineKey);
    } catch (error) {
      log.warn("could not read back an app's sent line", { error: String(error) });
    }
  }
  if (recorded === null) {
    log.warn("an app's send went out but is not on record", { chat: chat.ref.id });
  }
  const message = { chat: chat.ref, id: recorded ?? 0 };
  const platformMessageId = platformIdOfLine(key, sender.account.id, lineKey);
  return {
    message,
    ...(platformMessageId ? { platformMessageId } : {}),
    ...(landedIn !== null && recorded !== null ? { thread: { chat: chat.ref, id: recorded } } : {}),
    delivery: { state: "sent", at },
  };
}

/**
 * The direct message that reaches `account`: the one Rome holds with it,
 * else the one the sender's channel opens, which a provider call may do.
 */
async function dm(
  deps: AppChatsDeps,
  account: Account,
  opts: SendOptions | undefined,
): Promise<SdkChatRef> {
  const sender = soleSender(deps, account.platform, opts?.as);
  const held = deps.chats.byKey(
    directMessageOn(account.platform, sender.account.id, account.id, account.id),
  );
  if (held?.kind === "dm") return held.ref;
  const direct = (sender.channel.send as ChannelSend).direct;
  if (!direct) {
    throw new SendError("unsupported", `${describe(sender.account)} opens no direct messages`);
  }
  let address: ChatId | null;
  try {
    address = await direct.chatFor(account.id);
  } catch (error) {
    if (error instanceof ChannelNotConnected) {
      throw new SendError("not_connected", `No Connection reaches ${describe(sender.account)}`);
    }
    throw new SendError("no_dm", error instanceof Error ? error.message : String(error));
  }
  if (address === null) {
    throw new SendError("no_dm", `${account.platform} opened no direct message with ${account.id}`);
  }
  // The channel may have reconnected as another account while the platform
  // answered, and the address is the first account's.
  if (deps.adapters.accountOn(sender.channel.name).id !== sender.account.id) {
    throw new SendError("not_connected", `${describe(sender.account)} is no longer connected`);
  }
  const key = deps.adapters.directMessageReached(sender.channel.name, account.id, address);
  return deps.chats.start(key, "dm", null).ref;
}

/** The account a new direct message on `platform` goes out from: `as`, else
 *  Rome's only account there. */
function soleSender(deps: AppChatsDeps, platform: string, as: Account | undefined): Sender {
  if (as) {
    if (as.platform !== platform) {
      throw new SendError("sender_not_in_chat", `${describe(as)} is not on ${platform}`);
    }
    return senderAs(deps, as);
  }
  const accounts = deps.channelsOn(platform).map((name) => deps.adapters.accountOn(name));
  const [only] = accounts;
  if (!only) throw new SendError("not_connected", `Rome holds no account on ${platform}`);
  if (accounts.length > 1) {
    throw new SendError(
      "sender_ambiguous",
      `Rome holds ${accounts.length} accounts on ${platform}; name one as \`as\``,
    );
  }
  return senderAs(deps, only, { inferred: true });
}

/**
 * The groups on `platform` named `name`, oldest first, or only those where
 * `as` speaks. A group Rome has never heard of is not found: it is in Chats
 * once a message there reached Rome or Rome said one.
 */
function group(
  deps: AppChatsDeps,
  query: { platform: string; name: string; as?: Account },
): SdkChatRef[] {
  const { as } = query;
  if (as && as.platform !== query.platform) {
    throw new SendError("sender_not_in_chat", `${describe(as)} is not on ${query.platform}`);
  }
  return deps.chats
    .list(query.platform)
    .filter((chat) => chat.kind === "group" && chat.name === query.name)
    .filter((chat) => !as || deps.speakers.speakerIn(chat.ref.id, null, as.id) !== null)
    .map((chat) => chat.ref);
}

/** `out` as it goes on record: its parts, else its text, with a note for
 *  each attachment, which Chats keeps no file of. */
function recordedParts(out: ChatMessage, given: readonly MessagePart[]): MessagePart[] {
  const notes = (out.attachments ?? []).map(
    (attachment) => `[${attachment.type}${attachment.caption ? `: ${attachment.caption}` : ""}]`,
  );
  const said: MessagePart[] = given.length
    ? [...given]
    : out.text
      ? [{ type: "text", content: out.text }]
      : [];
  return notes.length ? [...said, { type: "text", content: notes.join("\n") }] : said;
}

function describe(account: Account): string {
  return `${account.platform} account ${account.id}`;
}
