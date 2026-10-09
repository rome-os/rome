// The contract between the reply delivery engine and a platform. The engine
// never names a platform: what a platform can do arrives as capabilities, how
// a reply should look as a policy, and the platform's API as a transport.
// Requirements: issue #427.
import { z } from "zod";
import type { Budget } from "./pacer.js";

/** Facts about a platform, declared by its integration. Not configurable. */
export interface DeliveryCapabilities {
  /** The most a message may hold, in the codec's measure of rendered text. */
  maxPartLength: number;
  /** The platform can replace a message's text after sending it. */
  edit: boolean;
  /** How fast one account may write. Every write the account makes, ordinary
   *  sends included, shares it. */
  budget: Budget;
}

/**
 * How replies stream. Validated configuration, narrowed by capabilities:
 * `edit` on a platform that cannot edit delivers as `blocks`.
 */
const deliveryPolicySchema = z.object({
  /**
   * `edit` creates a message early and keeps replacing its text. `blocks`
   * sends each part once its text is settled. `final` sends nothing until the
   * reply is finished.
   */
  mode: z.enum(["edit", "blocks", "final"]),
  /** The least time between two writes to the same message, in `edit` mode. */
  editIntervalMs: z.number().int().nonnegative(),
  /** How long a `blocks` part may wait for more text before it is sent. */
  blockWaitMs: z.number().int().nonnegative(),
  /** The most source text that may wait unsent in `edit` and `blocks` mode,
   *  which includes the text of a preview still open. It must exceed the
   *  platform's longest message. A reply that exceeds it fails rather than
   *  dropping text. A `final` reply waits by design and has no bound. */
  maxPendingChars: z.number().int().positive(),
});

export type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;
export type DeliveryMode = DeliveryPolicy["mode"];

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
 * - `unknown`: the write may or may not have happened (a timeout, a lost
 *   answer). A create that ends this way is never repeated.
 */
export class DeliveryFailure extends Error {
  constructor(
    readonly kind: "rejected" | "unauthorized" | "rate-limited" | "unsupported" | "unknown",
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
