// What one of Rome's seats says into its place, recorded in Chats and linked
// to the turn that said it. Vocabulary: docs/domains/chats.md#message and
// docs/domains/participation.md#reply.

import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { Channel } from "@rome-os/app-runtime";
import { channelAdapter, type Outbound } from "../chats/adapter.js";
import type { MessageRepository } from "../chats/message-repository.js";
import { keyOf, messageIdIn, ownedBy } from "../chats/place.js";
import type { MessagePart } from "../types.js";
import type { TurnLinks } from "./turn-links.js";

export interface SeatRepliesDeps {
  seats: Pick<WebChatRepository, "seatOf" | "addressIn">;
  messages: Pick<MessageRepository, "send">;
  links: Pick<TurnLinks, "answer">;
}

/** Delivers a message on its channel and answers the platform's id for it,
 *  when the platform gives one. Throws when the platform refused it. */
export type ChannelDeliver = () => Promise<{ platformMessageId?: string }>;

/** What a seat said: its id in Chats, or null when it was not recorded. */
export interface SeatSent {
  readonly id: string | null;
  readonly at: Date;
}

export class SeatReplies {
  constructor(private readonly deps: SeatRepliesDeps) {}

  /**
   * Say `parts` where session `sessionId` stands, as its account and agent,
   * through `deliver`, and make the message turn `turnId`'s answer when one
   * is named. Throws what `deliver` throws, and records nothing then. A
   * session that stands in no chat still delivers, and records nothing.
   */
  async say(
    sessionId: string,
    parts: readonly MessagePart[],
    deliver: ChannelDeliver,
    options: { turnId?: string; replyTo?: string } = {},
  ): Promise<SeatSent> {
    const seat = await this.deps.seats.seatOf(sessionId);
    if (!seat) {
      await deliver();
      return { id: null, at: new Date() };
    }
    // The adapter's id for a platform message of this seat's chat.
    const idOf = (platformMessageId: string) =>
      messageIdIn(
        seat.place.chat,
        ownedBy(keyOf(seat.place.chat), seat.accountId, platformMessageId),
      );
    const sent = await this.deps.messages.send(
      {
        direction: "fromRome",
        place: seat.place,
        saidBy: {
          account: { platform: seat.place.chat.platform, id: seat.accountId },
          agent: seat.agent,
        },
        parts,
        ...(options.replyTo === undefined ? {} : { replyTo: idOf(options.replyTo) }),
      },
      async () => {
        const { platformMessageId } = await deliver();
        return platformMessageId === undefined ? {} : { id: idOf(platformMessageId) };
      },
    );
    if (!sent.recorded) return { id: null, at: sent.at };
    if (options.turnId !== undefined) this.deps.links.answer(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at };
  }

  /**
   * Send `out` where session `sessionId` stands, through its account's
   * adapter on `channel`, record it as the seat's, and make it turn
   * `turnId`'s answer when one is named. Throws the platform's refusal, and
   * records nothing then. A session that stands in no chat sends nothing and
   * answers null.
   */
  async send(
    sessionId: string,
    channel: Channel,
    out: Outbound,
    options: { turnId?: string } = {},
  ): Promise<SeatSent | null> {
    const seat = await this.deps.seats.seatOf(sessionId);
    if (!seat) return null;
    const account = { platform: seat.place.chat.platform, id: seat.accountId };
    const adapter = channelAdapter(channel, {
      accountOf: () => account,
      platformOfChannel: () => account.platform,
      addressIn: (name, chatId) => this.deps.seats.addressIn(name, chatId),
    });
    const sent = await this.deps.messages.send(
      {
        direction: "fromRome",
        place: seat.place,
        saidBy: { account, agent: seat.agent },
        parts: out.parts ?? [{ type: "text", content: out.text }],
        ...(out.replyTo === undefined ? {} : { replyTo: out.replyTo }),
      },
      async () => ({
        id: await adapter.send(seat.place.chat.id, seat.place.threadId ?? null, {
          ...out,
          ...(options.turnId ? { turnId: options.turnId } : {}),
        }),
      }),
    );
    if (!sent.recorded) return { id: null, at: sent.at };
    if (options.turnId !== undefined) this.deps.links.answer(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at };
  }
}
