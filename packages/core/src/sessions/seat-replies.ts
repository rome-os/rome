// What one of Rome's seats says into its place, recorded in Chats and linked
// to the turn that said it. Vocabulary: docs/domains/chats.md#message and
// docs/domains/participation.md#reply.

import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { Deliver, MessageRepository, Sent } from "../chats/message-repository.js";
import { ownedBy } from "../chats/place.js";
import type { MessagePart } from "../types.js";
import type { TurnLinks } from "./turn-links.js";

export interface SeatRepliesDeps {
  seats: Pick<WebChatRepository, "seatOf">;
  messages: Pick<MessageRepository, "send">;
  links: Pick<TurnLinks, "answer">;
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
    deliver: Deliver,
    options: { turnId?: string; replyTo?: string } = {},
  ): Promise<Sent> {
    const seat = await this.deps.seats.seatOf(sessionId);
    if (!seat) {
      const { platformMessageId = "" } = await deliver();
      return { id: null, platformMessageId, at: new Date() };
    }
    const sent = await this.deps.messages.send(
      {
        direction: "fromRome",
        place: seat.place,
        saidBy: {
          account: { platform: seat.place.chat.platform, id: seat.accountId },
          agent: seat.agent,
        },
        parts,
        ...(options.replyTo === undefined
          ? {}
          : { replyTo: ownedBy(seat.place.chat, seat.accountId, options.replyTo) }),
      },
      async () => {
        const { platformMessageId } = await deliver();
        return platformMessageId === undefined
          ? {}
          : { platformMessageId: ownedBy(seat.place.chat, seat.accountId, platformMessageId) };
      },
    );
    if (options.turnId !== undefined && sent.id !== null) {
      this.deps.links.answer(sent.id, sessionId, options.turnId);
    }
    return sent;
  }
}
