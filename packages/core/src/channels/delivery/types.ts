// The contract between the reply delivery engine and a platform. The engine
// never names a platform: what a platform can do arrives as capabilities, how
// a reply should look as a policy, and the platform's API as a transport.
// Requirements: issue #427.

/** How fast one account may write to a platform. */
export interface Budget {
  /** Writes the account may make back to back before it has to wait. */
  burst: number;
  /** How long one write's allowance takes to come back. */
  refillMs: number;
  /**
   * The least time between two writes to the same conversation. A platform
   * whose conversations differ, such as private chats and groups, gives a
   * function of the conversation.
   */
  conversationSpacingMs: number | ((conversation: string) => number);
}

/** Facts about a platform, declared by its integration. Not configurable. */
export interface DeliveryCapabilities {
  /** The most a message may hold, in the codec's measure of rendered text. */
  maxPartLength: number;
  /** The platform can replace a message's text after sending it. */
  edit: boolean;
  /** How fast one account may write. Every write the account makes, ordinary
   *  sends included, shares it. This is the one authority: whoever wires the
   *  engine builds the account's Pacer from it. */
  budget: Budget;
}

/**
 * How replies stream, narrowed by capabilities: `edit` on a platform that
 * cannot edit delivers as `blocks`. Callers build a policy from constants, and
 * nothing parses one from configuration.
 */
export interface DeliveryPolicy {
  /**
   * `edit` creates a message early and keeps replacing its text. `blocks`
   * sends each part once its text is settled. `final` sends nothing until the
   * reply is finished.
   */
  mode: DeliveryMode;
  /** The least time between two writes to the same message, in `edit` mode. */
  editIntervalMs: number;
  /** How long a `blocks` part may wait for more text before it is sent. */
  blockWaitMs: number;
  /**
   * The most source text that may wait unsent in `edit` and `blocks` mode,
   * which includes the text of a preview still open. It must exceed the
   * platform's longest message, or an `edit` reply fails while its first
   * message is still filling, so a reply refuses a policy where it does not.
   * A reply that exceeds it fails rather than dropping text. A `final` reply
   * waits by design and has no bound.
   *
   * A block the agent never completes, as when a turn is interrupted
   * mid-block, holds the blocks after it back until the reply finishes, and its
   * text counts here.
   */
  maxPendingChars: number;
}

export type DeliveryMode = "edit" | "blocks" | "final";

/** The mode a reply uses: the policy's, unless the platform cannot do it. */
export function effectiveMode(
  policy: DeliveryPolicy,
  capabilities: DeliveryCapabilities,
): DeliveryMode {
  return policy.mode === "edit" && !capabilities.edit ? "blocks" : policy.mode;
}

/** Turns source text into what the platform displays, and measures it. */
export interface TextCodec {
  /** `settled` is false for a preview, so a codec may close what the source
   *  leaves open (a fenced block, an emphasis). */
  render(source: string, settled: boolean): string;
  /** The platform's measure of `rendered`. Must not shrink as `rendered`
   *  grows from a longer source. */
  measure(rendered: string): number;
}

export const plainText: TextCodec = {
  render: (source) => source,
  measure: (rendered) => rendered.length,
};

/** A message the platform accepted. */
export interface PartReceipt {
  messageId: string;
  /** Where the message landed, which can differ from where it was sent (a
   *  thread the platform opened). */
  conversationId: string;
}

/** The platform's write operations, as a transport implements them. Every
 *  method throws only {@link DeliveryFailure}. */
export interface DeliveryTransport {
  readonly capabilities: DeliveryCapabilities;
  readonly codec: TextCodec;
  create(conversationId: string, text: string, replyTo?: string): Promise<PartReceipt>;
  /** Present when `capabilities.edit`. Replacing text with the text already
   *  there succeeds. */
  edit?(receipt: PartReceipt, text: string): Promise<void>;
}

/**
 * Why a platform write did not succeed:
 *
 * - `rejected`: the platform refused it and will refuse it again.
 * - `unauthorized`: the credential no longer works. Never answered with a
 *   new message instead.
 * - `rate-limited`: try again after `retryAfterMs`. The whole account waits,
 *   since the platform does not say whose limit it hit.
 * - `unsupported`: the platform cannot do this at all (an edit it does not
 *   allow).
 * - `unavailable`: the write certainly did not arrive, because the platform
 *   could not be reached or the write never left its queue. It may be sent
 *   again, and a caller can send the reply whole.
 * - `unknown`: the write may or may not have happened (a timeout, a lost
 *   answer). A create that ends this way is never repeated.
 */
export class DeliveryFailure extends Error {
  constructor(
    readonly kind:
      | "rejected"
      | "unauthorized"
      | "rate-limited"
      | "unsupported"
      | "unavailable"
      | "unknown",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DeliveryFailure";
  }
}

export function asDeliveryFailure(error: unknown): DeliveryFailure {
  if (error instanceof DeliveryFailure) return error;
  return new DeliveryFailure("unknown", error instanceof Error ? error.message : String(error));
}
