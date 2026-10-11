import { makeWebchatDescriptor } from "../connections/integrations/webchat.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { type ChannelSurface, talkerChannelSurface } from "../core/agent-session.js";

const webchatTalker = makeWebchatDescriptor({ webchatRepo: {} as WebChatRepository }).capabilities
  .talker;

/** The channel surfaces production declares, for session managers built in
 *  tests: webchat's comes from its descriptor, and every other channel is
 *  messaging. */
export function testChannelSurface(channel: string): ChannelSurface | null {
  return channel === "webchat" && webchatTalker ? talkerChannelSurface(webchatTalker) : null;
}
