import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import type { Clock } from "../../lib/clock.js";
import { createLogger } from "../../logger.js";
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
  /** The channel's reply port, read when a reply opens. */
  replies(channel: string): ChannelReplies | null | undefined;
  clock: Clock;
  chats?: Pick<WebChatRepository, "recordOutboundConversationMessage">;
  policy?: DeliveryPolicy;
}

/**
 * Opens the main-process owner of a run's reply to an external channel: one
 * ReplyDelivery per run, fed the run's events as they happen. Canonical
 * history stays in the conversation repository: a settled reply is recorded
 * there once, as the text the user was shown or may have been shown. That row
 * is the turn's only answer, since the run's transcript leaves a streamed
 * answer to it.
 */
export class ReplyStreams {
  constructor(private readonly deps: ReplyStreamsDeps) {}

  /**
   * A stream for `target`, or null when reply streaming is off or its channel
   * cannot stream. A reply that gets null is sent whole by its caller.
   */
  async open(target: ReplyTarget): Promise<ReplyStream | null> {
    if (!(await this.deps.streaming())) return null;
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

  private async record(target: ReplyTarget, outcome: ReplyOutcome): Promise<void> {
    // Every part showed or may have: a create whose result is unknown most
    // likely landed, and nothing sends it again.
    const shown = outcome.parts;
    if (!this.deps.chats || shown.length === 0) return;
    // A block's parts split its source, and each block is a message of its own.
    const text = shown
      .map((part, i) => (i > 0 && part.block !== shown[i - 1]!.block ? "\n\n" : "") + part.source)
      .join("");
    // The row's own id is the message that starts the answer, the last block.
    // A message whose create is unknown has no id, so the last block with one
    // stands in. The reply's other messages are kept beside it, so a quote of
    // any message the reply wrote reaches the row.
    const receipted = shown.filter((part) => part.receipt);
    const lastBlock = receipted.at(-1)?.block;
    const quoted = receipted.find((part) => part.block === lastBlock)?.receipt;
    const others = receipted.flatMap(({ receipt }) =>
      receipt && receipt !== quoted ? [receipt.messageId] : [],
    );
    try {
      await this.deps.chats.recordOutboundConversationMessage({
        sessionId: target.romeSessionId,
        content: JSON.stringify([{ type: "text", content: text }]),
        ...(quoted ? { platformMessageId: quoted.messageId } : {}),
        ...(others.length > 0 ? { otherPlatformMessageIds: others } : {}),
        senderId: "rome",
        senderName: "Rome",
        ...(target.replyToMessageId ? { replyToPlatformMessageId: target.replyToMessageId } : {}),
        turnId: target.turnId,
        knownToProvider: true,
      });
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
