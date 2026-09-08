import { getCurrentActionContext } from "@rome-os/app-runtime";

/**
 * Who wrote a person's fact.
 *
 * The runtime stamps `by`, never the manager agent, so the agent can pick the
 * task and the words but not the author. What it can stamp is limited by what
 * the platform tells an action: `getCurrentActionContext()` carries the calling
 * session, agent, and channel thread, but no guardian or user id — that is
 * deliberately dropped before the context reaches app code. So a chat message
 * from the guardian is stamped `guardian`, and only a channel that names its
 * sender narrows it further.
 */
export const DEFAULT_PERSON = "guardian";

export function personFromContext(): string {
  const channelUserId = getCurrentActionContext()?.channelContext?.channelUserId;
  return channelUserId?.trim() || DEFAULT_PERSON;
}
