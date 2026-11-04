import { WEBCHAT_CHANNEL, WEBCHAT_SURFACE } from "../connected-accounts/webchat-channel.js";
import type { ChannelSurface } from "../core/agent-session.js";

/** The channel surfaces production declares, for session managers built in
 *  tests: webchat's own, and every other channel is messaging. */
export function testChannelSurface(channel: string): ChannelSurface | null {
  return channel === WEBCHAT_CHANNEL ? WEBCHAT_SURFACE : null;
}
