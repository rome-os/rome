// What one of Rome's speakers says into its place, recorded in Chats and linked
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
import type { Speaker, Speakers } from "./speakers.js";
import type { TurnLinks } from "./turn-links.js";

const log = createLogger("speaker-replies");

export interface SpeakerRepliesDeps {
  speakers: Pick<Speakers, "speakerOf">;
  /** Each channel's chat adapter, which the speaker says its messages through. */
  adapters: Pick<ChatAdapters, "of" | "keyOf">;
  messages: Pick<MessageRepository, "send" | "byIds">;
  links: Pick<TurnLinks, "answer">;
}

/** Delivers a message on the speaker's channel to the chat its adapter keys
 *  `chatKey` and answers the adapter's key for it. Throws when the platform
 *  refused it. */
export type SpeakerDeliver = (speaker: Speaker, chatKey: string) => Promise<string>;

/** Where a delivered message landed, as {@link MessageRepository.send}
 *  takes it: only a thread other than the speaker's. */
function landed(speaker: Speaker, threadId: ChatId | null) {
  return threadId === (speaker.place.threadId ?? null) ? {} : { landedIn: { threadId } };
}

/** What a speaker said: its id in Chats, or null when it was not recorded. */
export interface SpeakerSent {
  readonly id: number | null;
  readonly at: Date;
}

/** A message a speaker sends: what its adapter takes, quoting a line by its id
 *  in Chats, or by its adapter's key for one Rome never recorded. The turn
 *  it answers is named once, in the send's options. */
export type SpeakerOutbound = Omit<Outbound, "replyTo" | "turnId"> & {
  readonly replyTo?: OutboundMessage["replyTo"];
};

export class SpeakerReplies {
  constructor(private readonly deps: SpeakerRepliesDeps) {}

  /**
   * Say `parts` where session `sessionId` stands, as its account and agent,
   * through `deliver`, and make the message turn `turnId`'s answer when one
   * is named. Throws what `deliver` throws, and records nothing then. A
   * session that stands in no chat sends nothing and answers null.
   */
  async say(
    sessionId: string,
    parts: readonly MessagePart[],
    deliver: SpeakerDeliver,
    options: { turnId?: string } = {},
  ): Promise<SpeakerSent | null> {
    const speaker = this.deps.speakers.speakerOf(sessionId);
    if (!speaker) return null;
    const sent = await this.deps.messages.send(
      {
        direction: "fromRome",
        place: speaker.place,
        saidBy: {
          account: { platform: speaker.place.chat.platform, id: speaker.accountId },
          agent: speaker.agent,
        },
        parts,
      },
      async (target) => ({ key: await deliver(speaker, target.chat) }),
    );
    if (sent.id === null) return { id: null, at: sent.at };
    if (options.turnId !== undefined) this.answered(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at };
  }

  /**
   * Send `out` where session `sessionId` stands, through its account's
   * adapter on `channel`, record it as the speaker's, and make it turn
   * `turnId`'s answer when one is named. `recorded` is the line as it goes on
   * record, when it says more than the platform shows. Answers the speaker it
   * was said through, the adapter's key for what went out as `sent`, and
   * the thread it landed in, or null for the open chat.
   * Throws the platform's refusal, and records nothing
   * then. A session that stands in no chat sends nothing and answers null.
   */
  async send(
    sessionId: string,
    channel: Channel,
    out: SpeakerOutbound,
    options: { turnId?: string; recorded?: readonly MessagePart[] } = {},
  ): Promise<(SpeakerSent & { sent: string; speaker: Speaker; landedIn: ChatId | null }) | null> {
    const speaker = this.deps.speakers.speakerOf(sessionId);
    if (!speaker) return null;
    const { account, adapter } = this.adapterOf(speaker, channel);
    const { replyTo, ...rest } = out;
    let lineKey = "";
    let landedIn: ChatId | null = speaker.place.threadId ?? null;
    const sent = await this.deps.messages.send(
      {
        direction: "fromRome",
        place: speaker.place,
        saidBy: { account, agent: speaker.agent },
        parts: options.recorded ?? out.parts ?? [{ type: "text", content: out.text }],
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      async (target) => {
        const out = await adapter.send(target.chat, speaker.place.threadId ?? null, {
          ...rest,
          ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
          ...(options.turnId ? { turnId: options.turnId } : {}),
        });
        lineKey = out.key;
        landedIn = out.threadId;
        return { key: lineKey, ...landed(speaker, out.threadId) };
      },
    );
    if (sent.id === null) return { id: null, at: sent.at, sent: lineKey, speaker, landedIn };
    if (options.turnId !== undefined) this.answered(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at, sent: lineKey, speaker, landedIn };
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
    const speaker = this.deps.speakers.speakerOf(sessionId);
    if (!speaker) return null;
    const { account, adapter } = this.adapterOf(speaker, channel);
    const replyTo = options.replyTo;
    const chat = this.deps.adapters.keyOf(speaker.place.chat);
    // A key names a line only in its own chat.
    const line = replyTo === undefined ? undefined : this.deps.messages.byIds([replyTo])[0];
    const quoted = line?.place.chat.id === speaker.place.chat.id ? line.key : null;
    const reply = adapter.stream?.(chat.externalId, speaker.place.threadId ?? null, {
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
              place: speaker.place,
              saidBy: { account, agent: speaker.agent },
              parts: [{ type: "text", content: settled.text }],
              ...(replyTo === undefined ? {} : { replyTo }),
            },
            async () => ({ key, ...landed(speaker, threadId) }),
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

  /** The speaker's account and `channel`'s adapter. Throws when the channel is
   *  another account's, so a message is never sent as one account and
   *  recorded as another's. */
  private adapterOf(speaker: Speaker, channel: Channel) {
    const account = { platform: speaker.place.chat.platform, id: speaker.accountId };
    const adapter = this.deps.adapters.of(channel);
    if (adapter.account.platform !== account.platform || adapter.account.id !== account.id) {
      throw new Error(
        `Channel "${channel.name}" is ${adapter.account.platform}:${adapter.account.id}, ` +
          `not the account speaker ${speaker.sessionId} speaks as`,
      );
    }
    return { account, adapter };
  }
}
