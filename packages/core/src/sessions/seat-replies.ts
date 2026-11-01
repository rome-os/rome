// What one of Rome's seats says into its place, recorded in Chats and linked
// to the turn that said it. Vocabulary: docs/domains/chats.md#message and
// docs/domains/participation.md#reply.

import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { Channel } from "@rome-os/app-runtime";
import type { ChatAdapters, Outbound, StreamedReply } from "../chats/adapter.js";
import type { DeliveryPolicy } from "../channels/delivery/types.js";
import type { Clock } from "../lib/clock.js";
import { createLogger } from "../logger.js";
import type { MessageRepository } from "../chats/message-repository.js";
import type { MessagePart } from "../types.js";
import type { TurnLinks } from "./turn-links.js";

const log = createLogger("seat-replies");

export type Seat = NonNullable<Awaited<ReturnType<WebChatRepository["seatOf"]>>>;

export interface SeatRepliesDeps {
  seats: Pick<WebChatRepository, "seatOf">;
  /** Each channel's chat adapter, which the seat says its messages through. */
  adapters: Pick<ChatAdapters, "of">;
  messages: Pick<MessageRepository, "send">;
  links: Pick<TurnLinks, "answer">;
}

/** Delivers a message on the seat's channel and answers the adapter's id for
 *  it. Throws when the platform refused it. */
export type SeatDeliver = (seat: Seat) => Promise<string>;

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
   * session that stands in no chat sends nothing and answers null.
   */
  async say(
    sessionId: string,
    parts: readonly MessagePart[],
    deliver: SeatDeliver,
    options: { turnId?: string } = {},
  ): Promise<SeatSent | null> {
    const seat = await this.deps.seats.seatOf(sessionId);
    if (!seat) return null;
    const sent = await this.deps.messages.send(
      {
        direction: "fromRome",
        place: seat.place,
        saidBy: {
          account: { platform: seat.place.chat.platform, id: seat.accountId },
          agent: seat.agent,
        },
        parts,
      },
      async () => ({ id: await deliver(seat) }),
    );
    if (!sent.recorded) return { id: null, at: sent.at };
    if (options.turnId !== undefined) this.deps.links.answer(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at };
  }

  /**
   * Send `out` where session `sessionId` stands, through its account's
   * adapter on `channel`, record it as the seat's, and make it turn
   * `turnId`'s answer when one is named. `recorded` is the line as it goes on
   * record, when it says more than the platform shows. Answers the seat it
   * was said through and the adapter's id for what went out as `sent`, which
   * is the line's id unless the line was on record already. Throws the platform's refusal, and records nothing
   * then. A session that stands in no chat sends nothing and answers null.
   */
  async send(
    sessionId: string,
    channel: Channel,
    out: Outbound,
    options: { turnId?: string; recorded?: readonly MessagePart[] } = {},
  ): Promise<(SeatSent & { sent: string; seat: Seat }) | null> {
    const seat = await this.deps.seats.seatOf(sessionId);
    if (!seat) return null;
    const { account, adapter } = this.adapterOf(seat, channel);
    const replyTo = out.replyTo;
    let lineId = "";
    const sent = await this.deps.messages.send(
      {
        direction: "fromRome",
        place: seat.place,
        saidBy: { account, agent: seat.agent },
        parts: options.recorded ?? out.parts ?? [{ type: "text", content: out.text }],
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      async () => {
        lineId = await adapter.send(seat.place.chat.id, seat.place.threadId ?? null, {
          ...out,
          ...(replyTo === undefined ? {} : { replyTo }),
          ...(options.turnId ? { turnId: options.turnId } : {}),
        });
        return { id: lineId };
      },
    );
    if (!sent.recorded) return { id: null, at: sent.at, sent: lineId, seat };
    if (options.turnId !== undefined) this.deps.links.answer(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at, sent: lineId, seat };
  }

  /**
   * Open a reply where session `sessionId` stands, written through its
   * account's adapter on `channel` as the run goes, and put it on record as
   * turn `turnId`'s answer once it settles. `replyTo` is the line it
   * answers. Null when the session stands in no chat or the channel cannot
   * stream.
   */
  async stream(
    sessionId: string,
    channel: Channel,
    options: { turnId: string; replyTo?: string; policy: DeliveryPolicy; clock: Clock },
  ): Promise<StreamedReply | null> {
    const seat = await this.deps.seats.seatOf(sessionId);
    if (!seat) return null;
    const { account, adapter } = this.adapterOf(seat, channel);
    const replyTo = options.replyTo;
    const reply = adapter.stream?.(seat.place.chat.id, seat.place.threadId ?? null, {
      ...(replyTo === undefined ? {} : { replyTo }),
      policy: options.policy,
      clock: options.clock,
    });
    if (!reply) return null;
    return {
      accept: (event) => reply.accept(event),
      stop: () => reply.stop(),
      settle: async (stopped) => {
        const settled = await reply.settle(stopped);
        if (settled.id === null) return settled;
        const id = settled.id;
        try {
          // Delivered already: recording says so.
          const sent = await this.deps.messages.send(
            {
              direction: "fromRome",
              place: seat.place,
              saidBy: { account, agent: seat.agent },
              parts: [{ type: "text", content: settled.text }],
              ...(replyTo === undefined ? {} : { replyTo }),
            },
            async () => ({ id }),
          );
          if (sent.recorded) this.deps.links.answer(sent.id, sessionId, options.turnId);
        } catch (error) {
          // The messages are already on the platform. A failed record must
          // not make anything send them again.
          log.warn("reply delivered but recording failed", {
            sessionId,
            turnId: options.turnId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return settled;
      },
    };
  }

  private adapterOf(seat: Seat, channel: Channel) {
    const account = { platform: seat.place.chat.platform, id: seat.accountId };
    return { account, adapter: this.deps.adapters.of(channel) };
  }
}
