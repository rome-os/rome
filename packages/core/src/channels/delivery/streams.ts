import type { Channel, StreamAgentEvent } from "@rome-os/app-runtime";
import type { ChatRepository } from "../../chats/chat-repository.js";
import type { MessageRepository } from "../../chats/message-repository.js";
import type { Clock } from "../../lib/clock.js";
import { createLogger } from "../../logger.js";
import type { SpeakerReplies } from "../../sessions/speaker-replies.js";
import type { ChannelReplies } from "../channel.js";
import { ReplyDelivery, type ReplyOutcome } from "./reply.js";
import type { ReplyStreamingSwitch } from "./streaming-switch.js";
import type { DeliveryPolicy } from "./types.js";

const log = createLogger("reply-streams");

/** Edit about once a second, the pace Telegram allows in one chat. A long
 *  answer arrives about a paragraph to a message. */
const DEFAULT_POLICY: DeliveryPolicy = {
  mode: "edit",
  editIntervalMs: 1000,
  blockWaitMs: 1500,
  maxPendingChars: 200_000,
  softPartLength: 100,
};

/** Where a run's reply goes. */
export interface ReplyTarget {
  channel: string;
  chatId: string;
  /** The message the reply answers, by the platform's id. */
  replyToMessageId?: string;
  /** The line the reply answers, by its id in Chats. Read when the reply
   *  goes through a speaker. */
  replyTo?: number;
  /** The conversation the run's turn is recorded in. */
  romeSessionId: string;
  turnId: string;
  /** The agent whose turn writes the reply. */
  agent?: string;
}

/** One run's reply, streaming. */
export interface ReplyStream {
  accept(event: StreamAgentEvent): void;
  /** Finishes the reply, or stops it when the run was stopped, and records
   *  what the user was shown. */
  settle(stopped: boolean): Promise<ReplyOutcome>;
  /** Stops writing at once, for a Stop that arrives mid-run. */
  stop(): void;
}

export interface ReplyStreamsDeps {
  /** Whether reply streaming is on, read when a reply opens. */
  streaming: ReplyStreamingSwitch;
  /** The channel's reply port, read when a reply opens. */
  replies(channel: string): ChannelReplies | null | undefined;
  clock: Clock;
  /** Where a settled reply is put on record. Absent, nothing records it. */
  messages?: Pick<MessageRepository, "recordSent">;
  /** The place the conversation a turn is recorded in stands for. */
  places?: Pick<ChatRepository, "placeOfRecord">;
  /** The speaker of the session a turn is recorded in, which writes the reply
   *  through its account's chat adapter and puts it on record as the turn's
   *  answer. Given, it takes the place of `replies`, `messages` and `places`. */
  speakers?: ReplyStreamsSpeakers;
  policy?: DeliveryPolicy;
}

export interface ReplyStreamsSpeakers {
  /** The channel a reply goes out on, read when a reply opens. Its send port
   *  must be the platform's own, not one that records its sends: the speaker
   *  records the reply. */
  channel(name: string): Channel | undefined;
  replies: Pick<SpeakerReplies, "stream">;
}

/**
 * Opens the main-process owner of a run's reply to an external channel: one
 * ReplyDelivery per run, fed the run's events as they happen. A settled
 * reply is put on record in its place once, as the text the user was shown or
 * may have been shown. That message is the turn's only answer, since the
 * run's transcript leaves a streamed answer to it. With `speakers`, the
 * session's speaker writes the reply and records it in Chats.
 */
export class ReplyStreams {
  constructor(private readonly deps: ReplyStreamsDeps) {}

  /**
   * A stream for `target`, or null when reply streaming is off, its channel
   * cannot stream, or, through a speaker, its session stands in no chat. A
   * reply that gets null is sent whole by its caller.
   */
  async open(target: ReplyTarget): Promise<ReplyStream | null> {
    if (!(await this.deps.streaming())) return null;
    if (this.deps.speakers) return await this.openAsSpeaker(target, this.deps.speakers);
    const replies = this.deps.replies(target.channel);
    if (!replies) return null;
    const delivery = new ReplyDelivery({
      transport: replies.transport,
      pacer: replies.pacer,
      policy: this.deps.policy ?? DEFAULT_POLICY,
      conversation: target.chatId,
      ...(target.replyToMessageId ? { replyTo: target.replyToMessageId } : {}),
      clock: this.deps.clock,
    });
    return {
      accept: (event) => delivery.accept(event),
      stop: () => void delivery.stop(),
      settle: async (stopped) => {
        const outcome = await (stopped ? delivery.stop() : delivery.finish());
        await this.record(target, outcome);
        this.warnUndelivered(target, outcome);
        return outcome;
      },
    };
  }

  /** The reply written and recorded by the speaker of the session the turn
   *  is recorded in. */
  private async openAsSpeaker(
    target: ReplyTarget,
    speakers: ReplyStreamsSpeakers,
  ): Promise<ReplyStream | null> {
    const channel = speakers.channel(target.channel);
    if (!channel) return null;
    const reply = await speakers.replies.stream(target.romeSessionId, channel, {
      turnId: target.turnId,
      ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
      ...(target.agent === undefined ? {} : { agent: target.agent }),
      policy: this.deps.policy ?? DEFAULT_POLICY,
      clock: this.deps.clock,
    });
    if (!reply) return null;
    return {
      accept: (event) => reply.accept(event),
      stop: () => reply.stop(),
      settle: async (stopped) => {
        const { outcome } = await reply.settle(stopped);
        this.warnUndelivered(target, outcome);
        return outcome;
      },
    };
  }

  private warnUndelivered(target: ReplyTarget, outcome: ReplyOutcome): void {
    if (outcome.status === "delivered") return;
    log.warn("reply not fully delivered", {
      channel: target.channel,
      turnId: target.turnId,
      status: outcome.status,
      failure: outcome.failure,
    });
  }

  private async record(target: ReplyTarget, outcome: ReplyOutcome): Promise<void> {
    // Every part showed or may have: a create whose result is unknown most
    // likely landed, and nothing sends it again.
    const shown = outcome.parts;
    const { messages, places } = this.deps;
    if (!messages || !places || shown.length === 0) return;
    // A block's parts split its source, and each block is a message of its own.
    const text = shown
      .map((part, i) => (i > 0 && part.block !== shown[i - 1]!.block ? "\n\n" : "") + part.source)
      .join("");
    // The message's own id is the one that starts the answer, the last block.
    // A message whose create is unknown has no id, so the last block with one
    // stands in. The reply's other messages are kept beside it, so a quote of
    // any message the reply wrote reaches it.
    const receipted = shown.filter((part) => part.receipt);
    const lastBlock = receipted.at(-1)?.block;
    const quoted = receipted.find((part) => part.block === lastBlock)?.receipt;
    const others = receipted.flatMap(({ receipt }) =>
      receipt && receipt !== quoted ? [receipt.messageId] : [],
    );
    try {
      const at = places.placeOfRecord(target.romeSessionId);
      if (!at) throw new Error(`No place for conversation ${target.romeSessionId}`);
      await messages.recordSent(
        {
          direction: "fromRome",
          place: at.place,
          parts: [{ type: "text", content: text }],
          ...(quoted ? { platformMessageId: quoted.messageId } : {}),
          ...(others.length > 0 ? { otherPlatformMessageIds: others } : {}),
          ...(target.replyToMessageId ? { replyTo: target.replyToMessageId } : {}),
          turnId: target.turnId,
          turnAnswer: true,
        },
        { channel: at.channel },
      );
    } catch (err) {
      // The messages are already on the platform. A failed record must not
      // make anything send them again.
      log.warn("reply delivered but conversation recording failed", {
        channel: target.channel,
        turnId: target.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
