// Whom a message addresses, for one of Rome's accounts.
// Vocabulary: docs/domains/participation.md#addressed.
//
// Pure functions over the facts a connection reports. A message carries no
// addressing of its own: two of Rome's accounts in one chat hear the same
// message, and it can address one and not the other.

/** Whom a message addresses, as one of Rome's accounts reads it. */
export type Addressed = "rome" | "others" | "nobody";

/** How a message addresses Rome's account, when it does. */
export type AddressedRomeBy = "direct" | "mention" | "reply" | "thread";

/** The facts addressing reads, in the platform's own ids. A connection's
 *  message carries them. */
export interface AddressingFacts {
  readonly where: {
    readonly kind: "direct" | "group";
    readonly thread?: { readonly startedBy?: string };
  };
  /** The individual accounts it mentions. Absent where the connection
   *  cannot tell, which reads as mentioning nobody. */
  readonly mentions?: readonly string[];
  readonly replyTo?: { readonly senderAccountId?: string };
}

/**
 * How `message` addresses `me`, Rome's account by the platform's id for it,
 * or null when it does not: a direct message, a mention of `me`, a reply to a
 * message `me` said, or a message in a thread `me` started, in that order.
 */
export function addressedRomeBy(message: AddressingFacts, me: string): AddressedRomeBy | null {
  if (message.where.kind === "direct") return "direct";
  if (message.mentions?.includes(me)) return "mention";
  if (message.replyTo?.senderAccountId === me) return "reply";
  if (message.where.thread?.startedBy === me) return "thread";
  return null;
}

/**
 * Whom `message` addresses, for `me`: `rome` when it addresses `me` in any
 * way {@link addressedRomeBy} names, `others` when it mentions or replies to
 * another account, and `nobody` otherwise. A reply to `me` that also mentions
 * someone else addresses `me`.
 *
 * Nothing outside tests calls this yet. The wake gate reads the fields apps
 * receive until ZHA-229 moves it onto this function, and until then a reply
 * to someone else is `others` here but `nobody` in the gate.
 */
export function addressing(message: AddressingFacts, me: string): Addressed {
  if (addressedRomeBy(message, me) !== null) return "rome";
  if (mentionsOthers(message, me)) return "others";
  const repliedTo = message.replyTo?.senderAccountId;
  if (repliedTo !== undefined && repliedTo !== me) return "others";
  return "nobody";
}

/** Whether `message` mentions an account other than `me`. */
export function mentionsOthers(message: AddressingFacts, me: string): boolean {
  return message.mentions?.some((account) => account !== me) ?? false;
}
