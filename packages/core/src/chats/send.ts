// Saying something into a place from outside an agent turn. Vocabulary:
// docs/domains/chats.md#place and docs/domains/chats.md#delivery. The wire
// answers are the People contract's (`@rome/api-types/people`).
//
// A send names a place, never an account. Reaching an account directly is
// finding the place first, which `people/send.ts` does for the People and
// assistants surfaces.
//
// Over today's storage a place's chat is a channel's conversation row, and the
// send goes out on the channel of the one of Rome's accounts that says it.
// Delivery is answered, not stored: the message is recorded once the platform
// took it, and a refused one is not recorded, until storage holds a delivery.
//
// A dashboard chat is the exception. Rome is its platform, so a send there is
// said as an agent's dashboard account and wakes the chat's agent, the way the
// guardian's composer does.

import type { Account } from "@rome-os/app-runtime";
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
import { createLogger } from "../logger.js";
import type { Delivery } from "./delivery.js";
import type { MessageRepository } from "./message-repository.js";
import { addressOf, type Place } from "./place.js";

const log = createLogger("chats-send");

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

/** The slice of the conversation repository a send opens its chat through. */
interface OutboundChats {
  ensureChannelChat(input: {
    channel: string;
    threadId: string;
    parentThreadId?: string;
  }): Promise<{ id: string }>;
}

export interface SendIntoPlaceDeps extends SendDeps {
  webchatRepo: OutboundChats;
  /** Where a sent message is put on record. */
  chatMessages: Pick<MessageRepository, "recordSent">;
  /** Rome's own account on a channel, which a send names as `as`. Absent, no
   *  channel answers to one. */
  accountOf?: ChannelRecordsRepository["accountOf"];
  /** Where a send into a dashboard chat goes. Absent, the dashboard takes no
   *  sends. */
  dashboard?: DashboardInbox;
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
    chatId: string,
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
 *  sender Rome cannot send as. Once the platform was asked, `delivery` says
 *  how the message stands with it. */
export type SendResult =
  | { ok: true; sent: SentMessage; delivery: Delivery }
  | { ok: false; send: RefusedState }
  | { ok: false; error: string; delivery: Delivery }
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

  const address = addressOf(place);
  let messageId: string | null;
  try {
    messageId = (await channel.send.send(address, { text: body.text })).messageId ?? null;
  } catch (error) {
    // The Connection went between choosing the sender and asking it: the same
    // answer a send that found none to begin with gives.
    if (error instanceof ChannelNotConnected) return { ok: false, send: "not-connected" };
    const words = error instanceof Error ? error.message : String(error);
    return { ok: false, error: words, delivery: { state: "failed", error: words, at: new Date() } };
  }

  const at = new Date();
  await record(deps, channel.name, place, body, messageId);
  return {
    ok: true,
    sent: {
      ref: messageId === null ? null : `${address}:${messageId}`,
      timestamp: Math.floor(at.getTime() / 1000),
    },
    delivery: { state: "sent", at },
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
  if (!posted.ok) {
    return {
      ok: false,
      error: posted.error,
      delivery: { state: "failed", error: posted.error, at: new Date() },
    };
  }
  return {
    ok: true,
    sent: {
      ref: `${place.chat.id}:${posted.messageId}`,
      timestamp: Math.floor(posted.at.getTime() / 1000),
    },
    delivery: { state: "sent", at: posted.at },
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

/** Rome's own transcript of what it said, written under the channel that
 *  sent it so the line joins the chat Rome holds there. On a channel with a
 *  mirror of its own it sits behind the provider's copy, which is the store
 *  precedence in `people/timeline-sources.ts`. */
async function record(
  deps: SendIntoPlaceDeps,
  channel: string,
  place: Place,
  body: Body,
  messageId: string | null,
): Promise<void> {
  try {
    await deps.webchatRepo.ensureChannelChat({
      channel,
      threadId: addressOf(place),
      ...(place.threadId === undefined ? {} : { parentThreadId: place.chat.id }),
    });
    await deps.chatMessages.recordSent(
      {
        direction: "fromRome",
        place,
        parts: [{ type: "text", content: body.text }],
        ...(messageId ? { platformMessageId: messageId } : {}),
        // Not said by an agent turn.
        turnAnswer: false,
      },
      { channel },
    );
  } catch (error) {
    log.warn("outbound message delivered but recording failed", {
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
