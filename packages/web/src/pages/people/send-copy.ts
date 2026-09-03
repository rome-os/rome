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
 * One of the three is not a fact about the account at all. "Unsupported" means
 * a different thing per channel — LinkedIn is an inbox Rome mirrors and cannot
 * write to, while a channel Rome has simply not taught to send is a gap that
 * will close — so its copy is keyed on the channel name, the way
 * `./channel-meta.tsx` already keys labels and glyphs. A channel with no entry
 * falls back to the general line, which is the branch every channel added after
 * this was written lands in.
 */

/** Every send state that is a refusal — the four minus the one that is not. */
export type RefusedSendState = Exclude<AccountSendState, "yes">;

/** Channels whose "unsupported" has a reason of its own to give. */
const UNSUPPORTED_COPY: Record<string, string> = {
  linkedin: "send.refusal.unsupported.linkedin",
};

/**
 * The people-namespace key that says why this account cannot be written to.
 *
 * Every key it can answer interpolates `{{channel}}`, so a caller renders it as
 * `t(key, { channel: channelLabel(t, channel) })` — the channel's own localized
 * name rather than its wire slug.
 */
export function sendRefusalKey(send: RefusedSendState, channel: string): string {
  switch (send) {
    case "not-connected":
      return "send.refusal.notConnected";
    case "no-conversation":
      return "send.refusal.noConversation";
    case "unsupported":
      return UNSUPPORTED_COPY[channel] ?? "send.refusal.unsupported.default";
  }
}
