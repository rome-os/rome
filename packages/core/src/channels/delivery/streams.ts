import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { SeatReplies } from "../../sessions/seat-replies.js";
import type { Clock } from "../../lib/clock.js";
import { createLogger } from "../../logger.js";
import type { Channel } from "@rome-os/app-runtime";
import type { ReplyOutcome } from "./reply.js";
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
  /** The message the reply answers. */
  replyToMessageId?: string;
  /** The conversation the run's turn is recorded in. */
  romeSessionId: string;
  turnId: string;
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
  /** The channel a reply goes out on, read when a reply opens. */
  channel(name: string): Channel | undefined;
  clock: Clock;
  /** The seat's replies, which write the reply through the channel's chat
   *  adapter and put it on record as its turn's answer. */
  said: Pick<SeatReplies, "stream">;
  policy?: DeliveryPolicy;
}

/**
 * Opens the main-process owner of a run's reply to an external channel, fed
 * the run's events as they happen. The reply is written through the chat
 * adapter of the seat the turn is recorded in, and settles to one line on
 * record, the text the user was shown or may have been shown. That message is
 * the turn's only answer, since the run's transcript leaves a streamed answer
 * to it.
 */
export class ReplyStreams {
  constructor(private readonly deps: ReplyStreamsDeps) {}

  /**
   * A stream for `target`, or null when reply streaming is off, its channel
   * cannot stream, or its session stands in no chat. A reply that gets null
   * is sent whole by its caller.
   */
  async open(target: ReplyTarget): Promise<ReplyStream | null> {
    if (!(await this.deps.streaming())) return null;
    const channel = this.deps.channel(target.channel);
    if (!channel) return null;
    const reply = await this.deps.said.stream(target.romeSessionId, channel, {
      turnId: target.turnId,
      ...(target.replyToMessageId ? { replyToPlatformMessageId: target.replyToMessageId } : {}),
      policy: this.deps.policy ?? DEFAULT_POLICY,
      clock: this.deps.clock,
    });
    if (!reply) return null;
    return {
      accept: (event) => reply.accept(event),
      stop: () => reply.stop(),
      settle: async (stopped) => {
        const { outcome } = await reply.settle(stopped);
        if (outcome.status !== "delivered")
          log.warn("reply not fully delivered", {
            channel: target.channel,
            turnId: target.turnId,
            status: outcome.status,
            failure: outcome.failure,
          });
        return outcome;
      },
    };
  }
}
