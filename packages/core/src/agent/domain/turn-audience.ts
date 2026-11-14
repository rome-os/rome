// Who can read what a turn says. Domain: docs/domains/participation.md#audience.

import type { ThreadContext } from "@rome-os/app-runtime";

/** `private`: only the guardian reads the turn. `shared`: anyone else may. */
export type Audience = "private" | "shared";

/**
 * The connection kinds whose private chats are a direct message between
 * Rome's account and one person. Email is not one: Rome marks every email
 * thread private while its other recipients read each reply too.
 */
const DIRECT_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "telegram",
  "telegram_user",
  "whatsapp",
  "discord",
  "wechat",
  "wechat_user",
  "linkedin",
  "slack",
  "feishu",
  "lark",
]);

/**
 * Who can read a chat on a messaging connection of kind `kind`: private only
 * for a direct message the guardian sent. Any other kind, the dashboard's
 * included, is shared here; the dashboard's chats are read by their own rule.
 */
export function messagingAudience(context: ThreadContext, kind: string): Audience {
  if (!DIRECT_MESSAGE_KINDS.has(kind)) return "shared";
  return context.threadType === "private" && context.senderBondLevel === "guardian"
    ? "private"
    : "shared";
}

/**
 * The audience of a turn, read when it starts. `place` is the audience of
 * the session's chat as its opener read it, with what only the opener knows:
 * the connection kind behind a channel, and who may open a dashboard chat.
 * Without it, a direct message is read by its channel id alone and a
 * dashboard chat is shared. A turn that acts for someone other than the
 * guardian is shared. A turn started by another turn (a subagent's, a fork's)
 * is never more private than `parent`.
 */
export function turnAudience(
  context: ThreadContext | undefined,
  facts: { actor?: { kind: string }; parent?: Audience; place?: Audience } = {},
): Audience {
  if (facts.parent === "shared") return "shared";
  if (facts.actor && facts.actor.kind !== "guardian") return "shared";
  if (!context) return "shared";
  if (facts.place) return facts.place;
  if (context.channel === "webchat") return "shared";
  return messagingAudience(context, context.channel);
}

/** The narrower of two audiences: shared when either is. */
export function narrowerAudience(a: Audience, b: Audience | undefined): Audience {
  return a === "shared" || b === "shared" ? "shared" : "private";
}
