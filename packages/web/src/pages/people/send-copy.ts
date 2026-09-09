import type { AccountSendState } from "@rome/api-types/people";

/**
 * Why Rome cannot send to an account, in the dashboard's words.
 *
 * The server declares which of the three refusals it is and never a sentence:
 * `AccountSendState` crosses the wire, the copy does not, so every locale reads
 * the same way and a `SendRefusal` racing a disconnect renders as the line the
 * composer would already have shown. A pure key map, like
 * `@/lib/connection-capability-copy` — the consumer owns the `t()` call.
 *
 */

/** Every send state that is a refusal — the four minus the one that is not. */
export type RefusedSendState = Exclude<AccountSendState, "yes">;

/**
 * The people-namespace key that says why this account cannot be written to.
 *
 * Every key it can answer interpolates `{{channel}}`, so a caller renders it as
 * `t(key, { channel: channelLabel(t, channel) })` — the channel's own localized
 * name rather than its wire slug.
 */
export function sendRefusalKey(send: RefusedSendState): string {
  switch (send) {
    case "not-connected":
      return "send.refusal.notConnected";
    case "no-conversation":
      return "send.refusal.noConversation";
    case "unsupported":
      return "send.refusal.unsupported.default";
  }
}
