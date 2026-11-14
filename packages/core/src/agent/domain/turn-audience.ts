// Who can read what a turn says. Domain: docs/domains/participation.md#audience.

import type { ThreadContext } from "@rome-os/app-runtime";

/** `private`: only the guardian reads the turn. `shared`: anyone else may. */
export type Audience = "private" | "shared";

/**
 * The channels whose private chats are a direct message between Rome's
 * account and one person. Email is not one: Rome marks every email thread
 * private while its other recipients read each reply too. A channel not on
 * the list, such as a second connection of a kind under its own channel id,
 * is shared.
 */
const DIRECT_MESSAGE_CHANNELS: ReadonlySet<string> = new Set([
  "telegram",
  "telegram_user",
  "whatsapp",
  "discord",
  "wechat",
  "slack",
  "feishu",
  "lark",
]);

/**
 * The audience of a turn, read off its place and its sender when it starts.
 * A dashboard chat is private, a direct message is private only when the
 * guardian sent it, and anything unknown is shared. A turn that acts for
 * someone other than the guardian is shared. A turn started by another turn
 * (a subagent's, a fork's) is never more private than `parent`.
 */
export function turnAudience(
  context: ThreadContext | undefined,
  facts: { actor?: { kind: string }; parent?: Audience } = {},
): Audience {
  if (facts.parent === "shared") return "shared";
  if (facts.actor && facts.actor.kind !== "guardian") return "shared";
  if (!context) return "shared";
  if (context.channel === "webchat") return "private";
  if (!DIRECT_MESSAGE_CHANNELS.has(context.channel)) return "shared";
  return context.threadType === "private" && context.senderBondLevel === "guardian"
    ? "private"
    : "shared";
}

/** The narrower of two audiences: shared when either is. */
export function narrowerAudience(a: Audience, b: Audience | undefined): Audience {
  return a === "shared" || b === "shared" ? "shared" : "private";
}
