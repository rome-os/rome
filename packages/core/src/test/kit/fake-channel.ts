import { FakeTransport, type SentMessage } from "../helpers.js";
import type { ConversationId, MessageReceipt } from "@rome-os/app-runtime";
import type { OutgoingMessage } from "../../types.js";

// FakeChannelEndpoint — drive a conversation from the user's side.
//
// The chat-network SDK (grammy, Baileys, …) is the genuine edge; everything
// inward of a Connection's Talk should run for real. This endpoint plays the
// remote network: `receive()` delivers an incoming message exactly where the
// SDK would, and `nextReply()` awaits what Rome sent back out.

interface ReplyWaiter {
  resolve: (reply: SentMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class FakeChannelEndpoint extends FakeTransport {
  private waiters: ReplyWaiter[] = [];
  private readCursor = 0;

  override async send(
    conversationId: ConversationId,
    message: OutgoingMessage,
  ): Promise<MessageReceipt> {
    const receipt = await super.send(conversationId, message);
    this.drainWaiters();
    return receipt;
  }

  /** All messages Rome sent out on this channel so far. */
  replies(): SentMessage[] {
    return [...this.sentMessages];
  }

  /**
   * Await the next outgoing message not yet consumed by a previous
   * `nextReply()` call. Rejects after `timeoutMs` (default 2s) so a missing
   * reply fails the test instead of hanging it.
   */
  async nextReply(opts: { timeoutMs?: number } = {}): Promise<SentMessage> {
    if (this.readCursor < this.sentMessages.length) {
      return this.sentMessages[this.readCursor++];
    }
    const timeoutMs = opts.timeoutMs ?? 2_000;
    return new Promise<SentMessage>((resolve, reject) => {
      const waiter: ReplyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`No reply on channel "${this.channel}" within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0 && this.readCursor < this.sentMessages.length) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(this.sentMessages[this.readCursor++]);
    }
  }
}
