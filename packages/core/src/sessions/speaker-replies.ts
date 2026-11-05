// What one of Rome's speakers says into its place, recorded in Chats and linked
// to the turn that said it. Vocabulary: docs/domains/chats.md#message and
// docs/domains/participation.md#reply.
//
// Nothing calls this yet: the Chats switch moves Agents' replies onto it.

import type { Channel, ChatId } from "@rome-os/app-runtime";
import type { DeliveryPolicy } from "../connections/sending.js";
import type { OutboundMessage } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import {
  messageKeyAt,
  type ChatAdapters,
  type Outbound,
  type StreamedReply,
} from "../connections/chat-adapter.js";
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
  /** Moves session `sessionId`'s activity up to `at`, when it is later. */
  activity?: (sessionId: string, at: Date) => void;
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

/** A message a speaker sends: what its adapter takes, quoting a message by its id
 *  in Chats, or by its adapter's key for one Rome never recorded. The turn
 *  it answers is named once, in the send's options. */
export type SpeakerOutbound = Omit<Outbound, "replyTo" | "turnId"> & {
  readonly replyTo?: OutboundMessage["replyTo"];
};

/** How many turns' agents are kept. A reply is sent while its turn runs, so
 *  only the latest turns are ever asked for. */
const TURN_AGENTS_KEPT = 1024;

export class SpeakerReplies {
  /** The agent each recent turn runs, by its id. */
  private readonly turnAgents = new Map<string, string>();

  constructor(private readonly deps: SpeakerRepliesDeps) {}

  /**
   * Note that turn `turnId` runs `agent`. An account's own agent runs a
   * session that still names main, so a reply the turn sends without
   * naming its agent is said by the agent that ran it, not by the
   * session's. Kept in memory: a turn's replies go out while it runs.
   */
  runs(turnId: string, agent: string): void {
    this.turnAgents.delete(turnId);
    this.turnAgents.set(turnId, agent);
    if (this.turnAgents.size > TURN_AGENTS_KEPT) {
      const oldest = this.turnAgents.keys().next().value;
      if (oldest !== undefined) this.turnAgents.delete(oldest);
    }
  }

  /** The agent turn `turnId` runs, when it was noted. */
  agentOf(turnId: string | undefined): string | undefined {
    return turnId === undefined ? undefined : this.turnAgents.get(turnId);
  }

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
          agent: this.agentOf(options.turnId) ?? speaker.agent,
        },
        parts,
      },
      async (target) => ({ key: await deliver(speaker, target.chat) }),
    );
    this.active(sessionId, sent.at);
    if (sent.id === null) return { id: null, at: sent.at };
    if (options.turnId !== undefined) this.answered(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at };
  }

  /**
   * Send `out` where session `sessionId` stands, through its account's
   * adapter on `channel`, record it as the speaker's, and make it turn
   * `turnId`'s answer when one is named. `recorded` is the message as it goes on
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
    options: { turnId?: string; recorded?: readonly MessagePart[]; agent?: string } = {},
  ): Promise<(SpeakerSent & { sent: string; speaker: Speaker; landedIn: ChatId | null }) | null> {
    const speaker = this.deps.speakers.speakerOf(sessionId);
    if (!speaker) return null;
    const { account, adapter } = this.adapterOf(speaker, channel);
    const { replyTo, ...rest } = out;
    let messageKey = "";
    let landedIn: ChatId | null = speaker.place.threadId ?? null;
    const sent = await this.deps.messages.send(
      {
        direction: "fromRome",
        place: speaker.place,
        saidBy: { account, agent: options.agent ?? this.agentOf(options.turnId) ?? speaker.agent },
        parts: options.recorded ?? out.parts ?? [{ type: "text", content: out.text }],
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      async (target) => {
        const out = await adapter.send(target.chat, speaker.place.threadId ?? null, {
          ...rest,
          ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
          ...(options.turnId ? { turnId: options.turnId } : {}),
        });
        messageKey = out.key;
        landedIn = out.threadId;
        return { key: messageKey, ...landed(speaker, out.threadId) };
      },
    );
    this.active(sessionId, sent.at);
    if (sent.id === null) return { id: null, at: sent.at, sent: messageKey, speaker, landedIn };
    if (options.turnId !== undefined) this.answered(sent.id, sessionId, options.turnId);
    return { id: sent.id, at: sent.at, sent: messageKey, speaker, landedIn };
  }

  /**
   * Open a reply where session `sessionId` stands, written through its
   * account's adapter on `channel` as the run goes, and put it on record as
   * turn `turnId`'s answer once it settles. `replyTo` is the message it
   * answers, by its id in Chats. Null when the session stands in no chat or
   * the channel cannot stream.
   */
  async stream(
    sessionId: string,
    channel: Channel,
    options: {
      turnId: string;
      replyTo?: number;
      /** The message it answers by the platform's id, where Chats holds no
       *  copy of it. */
      replyToPlatformId?: string;
      /** The agent whose turn writes the reply, when it is not the one the
       *  session names, as an account's own agent is not. */
      agent?: string;
      policy: DeliveryPolicy;
      clock: Clock;
    },
  ): Promise<StreamedReply | null> {
    const speaker = this.deps.speakers.speakerOf(sessionId);
    if (!speaker) return null;
    const { account, adapter } = this.adapterOf(speaker, channel);
    const replyTo = options.replyTo;
    const chat = this.deps.adapters.keyOf(speaker.place.chat);
    // A key names a message only in its own chat.
    const line = replyTo === undefined ? undefined : this.deps.messages.byIds([replyTo])[0];
    const quoted =
      line?.place.chat.id === speaker.place.chat.id
        ? line.key
        : options.replyToPlatformId === undefined
          ? null
          : messageKeyAt(chat, speaker.accountId, options.replyToPlatformId);
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
        // Each message the platform shows is the turn's answer, in order. The
        // first answers the message the reply quotes.
        for (const [i, { text, key, threadId }] of settled.shown.entries()) {
          try {
            // Delivered already: recording says so.
            const sent = await this.deps.messages.send(
              {
                direction: "fromRome",
                place: speaker.place,
                saidBy: { account, agent: options.agent ?? speaker.agent },
                parts: [{ type: "text", content: text }],
                ...(i > 0 || replyTo === undefined ? {} : { replyTo }),
              },
              async () => ({ key, ...landed(speaker, threadId) }),
            );
            this.active(sessionId, sent.at);
            if (sent.id !== null) this.answered(sent.id, sessionId, options.turnId);
          } catch (error) {
            // The messages are already on the platform. A failed record must
            // not make anything send them again.
            log.warn("reply delivered but recording failed", {
              sessionId,
              turnId: options.turnId,
              key,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return settled;
      },
    };
  }

  /** Move the session's activity up to a message it said. The message is
   *  out already, so a failure is logged, as for a turn link. */
  private active(sessionId: string, at: Date): void {
    try {
      this.deps.activity?.(sessionId, at);
    } catch (error) {
      log.warn("reply sent but its session's activity could not move", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
