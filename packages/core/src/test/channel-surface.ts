import { WEBCHAT_CHANNEL, WEBCHAT_SURFACE } from "../chats/dashboard/dashboard-account.js";
import type { ChannelSurface } from "../core/session-opening.js";

/** The channel surfaces production declares, for session managers built in
 *  tests: webchat's own, and every other channel is messaging. */
export function testChannelSurface(channel: string): ChannelSurface | null {
  return channel === WEBCHAT_CHANNEL ? WEBCHAT_SURFACE : null;
}
