// What one of Rome's seats says into its place, recorded in Chats and linked
// to the turn that said it. Vocabulary: docs/domains/chats.md#message and
// docs/domains/participation.md#reply.
//
// Nothing calls this yet: the Chats switch moves Agents' replies onto it.

import type { Channel, ChatId } from "@rome-os/app-runtime";
import type { DeliveryPolicy } from "../channels/delivery/types.js";
import type { OutboundMessage } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import type { ChatAdapters, Outbound, StreamedReply } from "../connections/chat-adapter.js";
import type { Clock } from "../lib/clock.js";
import { createLogger } from "../logger.js";
import type { MessagePart } from "../types.js";
import type { Seat, Seats } from "./seats.js";
import type { TurnLinks } from "./turn-links.js";

const log = createLogger("seat-replies");

export interface SeatRepliesDeps {
  seats: Pick<Seats, "seatOf">;
  /** Each channel's chat adapter, which the seat says its messages through. */
  adapters: Pick<ChatAdapters, "of" | "keyOf">;
  messages: Pick<MessageRepository, "send" | "byIds">;
  links: Pick<TurnLinks, "answer">;
}

/** Delivers a message on the seat's channel to the chat its adapter keys
 *  `chatKey` and answers the adapter's key for it. Throws when the platform
 *  refused it. */
export type SeatDeliver = (seat: Seat, chatKey: string) => Promise<string>;

/** Where a delivered message landed, as {@link MessageRepository.send}
 *  takes it: only a thread other than the seat's. */
function landed(seat: Seat, threadId: ChatId | null) {
  return threadId === (seat.place.threadId ?? null) ? {} : { landedIn: { threadId } };
}

/** What a seat said: its id in Chats, or null when it was not recorded. */
export interface SeatSent {
  readonly id: number | null;
  readonly at: Date;
}

/** A message a seat sends: what its adapter takes, quoting a line by its id
 *  in Chats, or by its adapter's key for one Rome never recorded. The turn
 *  it answers is named once, in the send's options. */
export type SeatOutbound = Omit<Outbound, "replyTo" | "turnId"> & {
  readonly replyTo?: OutboundMessage["replyTo"];
};

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
    const seat = this.deps.seats.seatOf(sessionId);
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
      async (target) => ({ key: await deliver(seat, target.chat) }),
    );
    if (sent.id === null) return { id: null, at: sent.at };
    if (options.turnId !== undefined) this.answered(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at };
  }

  /**
   * Send `out` where session `sessionId` stands, through its account's
   * adapter on `channel`, record it as the seat's, and make it turn
   * `turnId`'s answer when one is named. `recorded` is the line as it goes on
   * record, when it says more than the platform shows. Answers the seat it
   * was said through and the adapter's key for what went out as `sent`.
   * Throws the platform's refusal, and records nothing
   * then. A session that stands in no chat sends nothing and answers null.
   */
  async send(
    sessionId: string,
    channel: Channel,
    out: SeatOutbound,
    options: { turnId?: string; recorded?: readonly MessagePart[] } = {},
  ): Promise<(SeatSent & { sent: string; seat: Seat }) | null> {
    const seat = this.deps.seats.seatOf(sessionId);
    if (!seat) return null;
    const { account, adapter } = this.adapterOf(seat, channel);
    const { replyTo, ...rest } = out;
    let lineKey = "";
    const sent = await this.deps.messages.send(
      {
        direction: "fromRome",
        place: seat.place,
        saidBy: { account, agent: seat.agent },
        parts: options.recorded ?? out.parts ?? [{ type: "text", content: out.text }],
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      async (target) => {
        const out = await adapter.send(target.chat, seat.place.threadId ?? null, {
          ...rest,
          ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
          ...(options.turnId ? { turnId: options.turnId } : {}),
        });
        lineKey = out.key;
        return { key: lineKey, ...landed(seat, out.threadId) };
      },
    );
    if (sent.id === null) return { id: null, at: sent.at, sent: lineKey, seat };
    if (options.turnId !== undefined) this.answered(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at, sent: lineKey, seat };
  }

  /**
   * Open a reply where session `sessionId` stands, written through its
   * account's adapter on `channel` as the run goes, and put it on record as
   * turn `turnId`'s answer once it settles. `replyTo` is the line it
   * answers, by its id in Chats. Null when the session stands in no chat or
   * the channel cannot stream.
   */
  async stream(
    sessionId: string,
    channel: Channel,
    options: { turnId: string; replyTo?: number; policy: DeliveryPolicy; clock: Clock },
  ): Promise<StreamedReply | null> {
    const seat = this.deps.seats.seatOf(sessionId);
    if (!seat) return null;
    const { account, adapter } = this.adapterOf(seat, channel);
    const replyTo = options.replyTo;
    const chat = this.deps.adapters.keyOf(seat.place.chat);
    // A key names a line only in its own chat.
    const line = replyTo === undefined ? undefined : this.deps.messages.byIds([replyTo])[0];
    const quoted = line?.place.chat.id === seat.place.chat.id ? line.key : null;
    const reply = adapter.stream?.(chat.externalId, seat.place.threadId ?? null, {
      ...(quoted === null ? {} : { replyTo: quoted }),
      policy: options.policy,
      clock: options.clock,
    });
    if (!reply) return null;
    return {
      accept: (event) => reply.accept(event),
      stop: () => reply.stop(),
      settle: async (stopped) => {
        const settled = await reply.settle(stopped);
        if (settled.key === null) return settled;
        const { key, threadId } = settled;
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
            async () => ({ key, ...landed(seat, threadId) }),
          );
          if (sent.id !== null) this.answered(sent.id, sessionId, options.turnId);
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

  /** Make message `messageId` turn `turnId`'s answer. The message is out
   *  and on record already, so a failed link is logged: failing the send
   *  would invite a second real message. */
  private answered(messageId: number, sessionId: string, turnId: string): void {
    try {
      this.deps.links.answer(messageId, sessionId, turnId);
    } catch (error) {
      log.warn("reply recorded but its turn link failed", {
        sessionId,
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The seat's account and `channel`'s adapter. Throws when the channel is
   *  another account's, so a message is never sent as one account and
   *  recorded as another's. */
  private adapterOf(seat: Seat, channel: Channel) {
    const account = { platform: seat.place.chat.platform, id: seat.accountId };
    const adapter = this.deps.adapters.of(channel);
    if (adapter.account.platform !== account.platform || adapter.account.id !== account.id) {
      throw new Error(
        `Channel "${channel.name}" is ${adapter.account.platform}:${adapter.account.id}, ` +
          `not the account seat ${seat.sessionId} speaks as`,
      );
    }
    return { account, adapter };
  }
}
