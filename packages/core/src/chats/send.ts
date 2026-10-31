// Saying something into a place from outside an agent turn. Vocabulary:
// docs/domains/chats.md#place and docs/domains/chats.md#delivery. The wire
// answers are the People contract's (`@rome/api-types/people`).
//
// A send names a place, never an account. Reaching an account directly is
// finding the place first, which `people/send.ts` does for the People and
// assistants surfaces.
//
// The send goes out on the channel of the one of Rome's accounts that says it,
// and the message is recorded once the platform took it. A refused send
// records nothing: its error is the answer.
//
// A dashboard chat is the exception. Rome is its platform, so a send there is
// said as an agent's dashboard account and wakes the chat's agent, the way the
// guardian's composer does.

import type { Account, ChatId } from "@rome-os/app-runtime";
import type { AccountSendState, SentMessage } from "@rome/api-types/people";
import { platformOf } from "@rome/api-types/platform";
import {
  ChannelNotConnected,
  channelsOn,
  type Channels,
  type PlatformOfChannel,
} from "../channels/channel.js";
import { WEBCHAT_CHANNEL } from "../channels/webchat-channel.js";
import type { ChannelRecordsRepository, SendersOn } from "../db/repositories/channel-records.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { channelAdapter } from "./adapter.js";
import type { ChatRepository } from "./chat-repository.js";
import type { MessageRepository } from "./message-repository.js";
import {
  addressOf,
  keyOf,
  messageIdIn,
  otherEndOf,
  ownedBy,
  platformIdOf,
  type Place,
} from "./place.js";

export interface SendDeps {
  channels: Channels;
  /** The platform each channel's accounts live on. Absent, the platform of
   *  the connection kind a channel is named after. */
  platformOfChannel?: PlatformOfChannel;
  /** The channels of Rome's accounts on a platform a Connection backs.
   *  Absent, or null for a platform, every channel on it. */
  sendersOn?: SendersOn;
}

/**
 * The channels of Rome's accounts a send on `platform` may go out from,
 * oldest first: each one a Connection backs, or, on a platform only Rome's own
 * channels serve, those channels. Asked at send time and never stored, since a
 * Connection that ends changes the answer and writes no record.
 */
export function sendersOf(deps: SendDeps, platform: string): string[] {
  return (
    deps.sendersOn?.(platform) ??
    channelsOn(deps.channels, deps.platformOfChannel ?? platformOf, platform)
  );
}

export interface SendIntoPlaceDeps extends SendDeps {
  /** Where the place's chat is found, or started on Rome's first message. */
  chats: Pick<ChatRepository, "get" | "start">;
  /** Where a sent message is put on record. */
  chatMessages: Pick<MessageRepository, "send">;
  /** Rome's own account on a channel, which a send names as `as`. Absent, no
   *  channel answers to one. */
  accountOf?: ChannelRecordsRepository["accountOf"];
  /** Where a send into a dashboard chat goes. Absent, the dashboard takes no
   *  sends. */
  dashboard?: DashboardInbox;
  /** Where a channel's seat heard its chat, which a direct message whose
   *  platform gives it an id of its own is sent to. */
  webchatRepo?: Pick<WebChatRepository, "addressIn">;
}

/** The dashboard's platform: Rome's own chat behind the guardian's sign-in. */
export const DASHBOARD_PLATFORM = platformOf(WEBCHAT_CHANNEL);

/**
 * The dashboard's side of a send. Rome is the dashboard's platform, so there
 * is nobody else to ask: the message is said once it is recorded, and the
 * chat's agent wakes on it as it does on the guardian's. Each agent has its
 * own account there, named by the agent's id.
 */
export interface DashboardInbox {
  post(
    key: string,
    body: Body,
    as: Account,
  ): Promise<{ ok: true; messageId: string; at: Date } | { ok: false; error: string }>;
}

/** What a message says. Text only, for now. */
export interface Body {
  text: string;
}

export type RefusedState = Exclude<AccountSendState, "yes">;

/** A send's answer: the platform took it, Rome refused before asking the
 *  platform, the platform refused in its own words, or the request named a
 *  sender Rome cannot send as. Only a send the platform took is on record. */
export type SendResult =
  | { ok: true; sent: SentMessage; at: Date }
  | { ok: false; send: RefusedState }
  | { ok: false; error: string; at: Date }
  | { ok: false; invalid: string };

/**
 * Who a send goes out as: one of Rome's accounts, or, over today's storage,
 * the channel that stands for one no record names yet.
 */
export type Sender = Account | { readonly channel: string };

/**
 * Say `body` in `place` as `as`, one of Rome's accounts on the place's
 * platform, and answer whether the platform took it. Absent `as`, Rome has to
 * hold one account there, and the send is refused as not connected while it
 * holds several or none.
 *
 * One platform call inside the call. Nothing is recorded for a message the
 * platform did not take. Once the platform has taken it, a failure to record
 * it is logged and the answer stands: reporting a sent message as failed
 * invites a second real message.
 */
export async function send(
  deps: SendIntoPlaceDeps,
  place: Place,
  body: Body,
  as?: Sender,
): Promise<SendResult> {
  const platform = place.chat.platform;
  if (platform === DASHBOARD_PLATFORM) return await sendOnDashboard(deps, place, body, as);
  // Absent `as`, Rome has to hold one account on the platform. With none or
  // several, no Connection answers for the place as such, and connecting or
  // removing an account is what settles it, so it reads as not connected. A
  // channel named as the sender that no longer sends there reads the same.
  const sender =
    as === undefined
      ? soleSender(deps, platform)
      : "channel" in as
        ? sendersOf(deps, platform).find((channel) => channel === as.channel)
        : senderNamed(deps, platform, as);
  if (sender === null) {
    return { ok: false, invalid: "Rome holds no account by that id that can send to this chat" };
  }
  const channel = sender && deps.channels.find((candidate) => candidate.name === sender);
  if (!channel) return { ok: false, send: "not-connected" };
  if (!channel.send) return { ok: false, send: "unsupported" };

  const account = deps.accountOf?.(channel.name) ?? { platform, id: channel.name };
  const chat =
    deps.chats.get(place.chat) ??
    deps.chats.start(place.chat, otherEndOf(keyOf(place.chat)) === null ? "group" : "dm", null);
  const adapter = channelAdapter(channel, {
    accountOf: () => account,
    platformOfChannel: () => platform,
    addressIn: (name, chatId) => deps.webchatRepo?.addressIn(name, chatId) ?? null,
  });
  let sent: Awaited<ReturnType<MessageRepository["send"]>>;
  try {
    sent = await deps.chatMessages.send(
      {
        direction: "fromRome",
        place,
        // The guardian's own line through Rome's account: no agent said it.
        saidBy: { account },
        parts: [{ type: "text", content: body.text }],
      },
      async () => ({
        id: await adapter.send(chat.ref.id, place.threadId ?? null, { text: body.text }),
      }),
    );
  } catch (error) {
    // The Connection went between choosing the sender and asking it: the same
    // answer a send that found none to begin with gives.
    if (error instanceof ChannelNotConnected) return { ok: false, send: "not-connected" };
    const words = error instanceof Error ? error.message : String(error);
    return { ok: false, error: words, at: new Date() };
  }
  return {
    ok: true,
    sent: {
      ref: `${addressOf(place)}:${platformIdOf(chat.ref.id, sent.id) ?? sent.id}`,
      timestamp: Math.floor(sent.at.getTime() / 1000),
    },
    at: sent.at,
  };
}

/**
 * A send into a dashboard chat. It names the agent account that says it,
 * since every agent holds one there and none is the dashboard's only one. A
 * dashboard chat has no threads.
 */
async function sendOnDashboard(
  deps: SendIntoPlaceDeps,
  place: Place,
  body: Body,
  as: Sender | undefined,
): Promise<SendResult> {
  if (as === undefined || "channel" in as || as.platform !== DASHBOARD_PLATFORM) {
    return {
      ok: false,
      invalid: "A send into a dashboard chat names the agent account it is from",
    };
  }
  if (place.threadId !== undefined) {
    return { ok: false, invalid: "A dashboard chat has no threads" };
  }
  if (!deps.dashboard) return { ok: false, send: "unsupported" };
  const posted = await deps.dashboard.post(place.chat.id, body, as);
  if (!posted.ok) return { ok: false, error: posted.error, at: new Date() };
  return {
    ok: true,
    sent: {
      ref: `${place.chat.id}:${posted.messageId}`,
      timestamp: Math.floor(posted.at.getTime() / 1000),
    },
    at: posted.at,
  };
}

/** The channel of Rome's account `as` on `platform`, if a send there may go
 *  out from it, and null if not. */
export function senderNamed(
  deps: Pick<SendIntoPlaceDeps, keyof SendDeps | "accountOf">,
  platform: string,
  as: Account,
): string | null {
  return (
    sendersOf(deps, platform).find((channel) => {
      const own = deps.accountOf?.(channel);
      return own?.platform === as.platform && own.id === as.id;
    }) ?? null
  );
}

/** The channel of Rome's only account on `platform`, or undefined while it
 *  holds none or several. */
export function soleSender(deps: SendDeps, platform: string): string | undefined {
  const senders = sendersOf(deps, platform);
  return senders.length === 1 ? senders[0] : undefined;
}
