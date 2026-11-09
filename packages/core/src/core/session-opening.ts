import type { ThreadContext } from "@rome-os/app-runtime";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import { createLogger } from "../logger.js";
import { sessionKeyChannel } from "./agent-session-key.js";
import type { AgentSessionInit } from "../agent/index.js";
import { isGuardianFacingChannel } from "./guardian-channel.js";

const log = createLogger("session-opening");

/** The parts of a channel's surface that change how its sessions prompt. */
export interface ChannelSurface {
  /** The next human turn arrives on a surface that renders interactive cards. */
  interactiveCards: boolean;
  /** Prompts carry the stored messages the agent has not seen. */
  promptContext: boolean;
}

/** What the named channel's surface supports, or null for a name no channel has. */
export type ChannelSurfaces = (channel: string) => ChannelSurface | null;

const MESSAGING_CHANNEL_SURFACE: ChannelSurface = {
  interactiveCards: false,
  promptContext: true,
};

/** The surface a channel's talker declares, with an omitted fact read as a
 *  messaging channel's. */
export function talkerChannelSurface(talker: {
  interactiveCards?: boolean;
  promptContext?: boolean;
}): ChannelSurface {
  return {
    interactiveCards: talker.interactiveCards ?? MESSAGING_CHANNEL_SURFACE.interactiveCards,
    promptContext: talker.promptContext ?? MESSAGING_CHANNEL_SURFACE.promptContext,
  };
}

/** A channel's surface. A name no channel has reads as a messaging channel. */
export function surfaceOf(surfaces: ChannelSurfaces, channel: string): ChannelSurface {
  return surfaces(channel) ?? MESSAGING_CHANNEL_SURFACE;
}

/** What an opener states about where a session opens, fixed for the session's life. */
export type SessionOpening = Required<
  Pick<AgentSessionInit, "drawsCards" | "guardianFacing" | "toolEnv" | "spanAttributes">
>;

export interface SessionOpeningDeps {
  channelSurface: ChannelSurfaces;
  /** The connection kind behind a channel id. When absent, every channel id reads as
   *  its own connection kind, which holds only where no connection kind has a second channel. */
  connectionKindOfChannel?: ConnectionKindOfChannel;
}

/** What an opener states for the session it opens under `continuityKey`. */
export type SessionOpeningFor = (
  continuityKey: string,
  threadContext?: ThreadContext,
) => SessionOpening;

/**
 * What an opener states for a session it opens: whether its conversation
 * shows cards and faces the guardian, and what its tools and spans carry.
 * The opener's thread context names the conversation; an opener without one
 * falls back to the channel the continuity key names.
 */
export function sessionOpeningFor(deps: SessionOpeningDeps): SessionOpeningFor {
  return (continuityKey, threadContext) => {
    const keyChannel = sessionKeyChannel(continuityKey);
    const openingChannel = threadContext?.channel ?? keyChannel;
    if (keyChannel && openingChannel !== keyChannel && deps.channelSurface(keyChannel) !== null) {
      log.warn("session opener's channel differs from the channel its key names", {
        channelThreadKey: continuityKey,
        openingChannel,
      });
    }
    return {
      drawsCards:
        !!openingChannel && surfaceOf(deps.channelSurface, openingChannel).interactiveCards,
      guardianFacing: isGuardianFacingChannel(continuityKey, deps.connectionKindOfChannel),
      // The channel the session's turns are delivered on. Shell tools such as
      // the Discord CLI read it to act as that channel's account. Set even
      // when undefined, so a value Rome itself inherited never leaks in.
      toolEnv: { ROME_CHANNEL: keyChannel },
      spanAttributes: keyChannel ? { "channel.name": keyChannel } : {},
    };
  };
}
