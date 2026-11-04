import type { Channel, StreamAgentEvent } from "@rome-os/app-runtime";
import type { Clock } from "../../lib/clock.js";
import { createLogger } from "../../logger.js";
import type { SpeakerReplies } from "../../sessions/speaker-replies.js";
import type { ReplyOutcome } from "./reply.js";
import type { ReplyStreamingSwitch } from "./streaming-switch.js";
import type { DeliveryPolicy } from "../../connections/sending.js";

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
  /** The message the reply answers, by its id in Chats. */
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
  clock: Clock;
  /** The speaker of the session a turn is recorded in, which writes the reply
   *  through its account's chat adapter and puts it on record as the turn's
   *  answer. */
  speakers: ReplyStreamsSpeakers;
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
 * reply per run, fed the run's events as they happen. The session's speaker
 * writes it through its account's chat adapter, and puts what the user was
 * shown, or may have been shown, on record in Chats once it settles. That is
 * the turn's only answer, since the run's transcript leaves a streamed answer
 * to it.
 */
export class ReplyStreams {
  constructor(private readonly deps: ReplyStreamsDeps) {}

  /**
   * A stream for `target`, or null when reply streaming is off, its channel
   * is gone or cannot stream, or its session stands in no chat. A reply that
   * gets null is sent whole by its caller.
   */
  async open(target: ReplyTarget): Promise<ReplyStream | null> {
    if (!(await this.deps.streaming())) return null;
    const { speakers } = this.deps;
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
}
