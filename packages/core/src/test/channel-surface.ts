import type { ChannelSurface } from "../core/agent-session.js";

/** The channel surfaces production declares, for session managers built in
 *  tests: webchat renders cards, and every other channel is messaging. */
export function testChannelSurface(channel: string): ChannelSurface | null {
  return channel === "webchat" ? { interactiveCards: true, promptContext: false } : null;
}
