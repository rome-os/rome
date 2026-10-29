// Saying something into a place from outside an agent turn. Vocabulary:
// docs/domains/chats.md#place and docs/domains/chats.md#delivery. The wire
// answers are the People contract's (`@rome/api-types/people`).
//
// A send names a place, never an account. Reaching an account directly is
// finding the place first, which `people/send.ts` does for the People and
// assistants surfaces.
//
// Over today's storage a place's chat is a channel's conversation row, and the
// send goes out on the channel of the one of Rome's accounts that says it. The
// message is recorded before the platform is asked, with its delivery pending,
// and the platform's answer settles it as sent or failed. Readers show only
// sent messages until they learn to show a delivery.
//
// A dashboard chat is the exception. Rome is its platform, so a send there is
// said as an agent's dashboard account and wakes the chat's agent, the way the
// guardian's composer does, with no delivery to wait on.

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
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";
import type { Delivery } from "./delivery.js";
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

/** The slice of the conversation repository a send writes through. */
type OutboundMessages = Pick<WebChatRepository, "recordPendingOutbound" | "setDelivery"> & {
  ensureChannelChat(input: {
    channel: string;
    threadId: string;
    parentThreadId?: string;
  }): Promise<{ id: string }>;
};

export interface SendIntoPlaceDeps extends SendDeps {
  webchatRepo: OutboundMessages;
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
 *  sender Rome cannot send as. */
export type SendResult =
  | { ok: true; sent: SentMessage }
  | { ok: false; send: RefusedState }
  | { ok: false; error: string }
  | { ok: false; invalid: string };

/** The sender Rome stamps on its own messages. `messages-agent.ts` reads it
 *  back to put the line on Rome's side of the chat. */
const ROME_SENDER = { senderId: "rome", senderName: "Rome" } as const;

/**
 * Say `body` in `place` as `as`, one of Rome's accounts on the place's
 * platform, and answer whether the platform took it. Absent `as`, Rome has to
 * hold one account there, and the send is refused as not connected while it
 * holds several or none.
 *
 * One platform call inside the call. Recording the message comes first, so a
 * failure to record throws before anything is said. Once the platform has
 * answered, a failure to settle the delivery is logged and the answer stands:
 * reporting a sent message as failed invites a second real message.
 */
export async function send(
  deps: SendIntoPlaceDeps,
  place: Place,
  body: Body,
  as?: Account,
): Promise<SendResult> {
  const platform = place.chat.platform;
  if (platform === DASHBOARD_PLATFORM) return await sendOnDashboard(deps, place, body, as);
  // Absent `as`, Rome has to hold one account on the platform. With none or
  // several, no Connection answers for the place as such, and connecting or
  // removing an account is what settles it, so it reads as not connected.
  const sender = as === undefined ? soleSender(deps, platform) : senderNamed(deps, platform, as);
  if (sender === null) {
    return { ok: false, invalid: "Rome holds no account by that id that can send to this chat" };
  }
  const channel = sender && deps.channels.find((candidate) => candidate.name === sender);
  if (!channel) return { ok: false, send: "not-connected" };
  if (!channel.send) return { ok: false, send: "unsupported" };

  const address = addressOf(place);
  const chat = await deps.webchatRepo.ensureChannelChat({
    channel: channel.name,
    threadId: address,
    ...(place.threadId === undefined ? {} : { parentThreadId: place.chat.id }),
  });
  const { id } = await deps.webchatRepo.recordPendingOutbound({
    sessionId: chat.id,
    content: JSON.stringify([{ type: "text", content: body.text }]),
    ...ROME_SENDER,
    at: new Date(),
  });

  let messageId: string | null;
  try {
    messageId = (await channel.send.send(address, { text: body.text })).messageId ?? null;
  } catch (error) {
    const words = error instanceof Error ? error.message : String(error);
    await settle(deps, channel.name, id, { state: "failed", error: words, at: new Date() });
    // The Connection went between choosing the sender and asking it: the same
    // answer a send that found none to begin with gives.
    if (error instanceof ChannelNotConnected) return { ok: false, send: "not-connected" };
    return { ok: false, error: words };
  }

  const at = new Date();
  await settle(deps, channel.name, id, { state: "sent", at }, messageId ?? undefined);
  return {
    ok: true,
    sent: {
      ref: messageId === null ? null : `${address}:${messageId}`,
      timestamp: Math.floor(at.getTime() / 1000),
    },
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
  as: Account | undefined,
): Promise<SendResult> {
  if (as?.platform !== DASHBOARD_PLATFORM) {
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
  if (!posted.ok) return { ok: false, error: posted.error };
  return {
    ok: true,
    sent: {
      ref: `${place.chat.id}:${posted.messageId}`,
      timestamp: Math.floor(posted.at.getTime() / 1000),
    },
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

function soleSender(deps: SendDeps, platform: string): string | undefined {
  const senders = sendersOf(deps, platform);
  return senders.length === 1 ? senders[0] : undefined;
}

async function settle(
  deps: SendIntoPlaceDeps,
  channel: string,
  id: string,
  delivery: Delivery,
  platformMessageId?: string,
): Promise<void> {
  try {
    await deps.webchatRepo.setDelivery(id, delivery, platformMessageId);
  } catch (error) {
    log.warn("platform answered but the delivery could not be recorded", {
      channel,
      delivery: delivery.state,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
