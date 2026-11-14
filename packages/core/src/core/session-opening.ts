import type { ThreadContext } from "@rome-os/app-runtime";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import { createLogger } from "../logger.js";
import { sessionKeyChannel } from "./agent-session-key.js";
import {
  type Audience,
  narrowerAudience,
  type SessionOpening,
  turnAudience,
} from "../agent/index.js";
import type { WebChatRepository } from "../webchat/repository.js";
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
  /** What the opener knows narrows the audience its place reads as, such as
   *  a visitor owning the dashboard chat. */
  audience?: Audience,
) => Required<Pick<SessionOpening, "drawsCards" | "guardianFacing" | "toolEnv" | "spanAttributes">>;

/**
 * What an opener states for a session it opens: whether its conversation
 * shows cards and faces the guardian, and what its tools and spans carry.
 * The opener's thread context names the conversation; an opener without one
 * falls back to the channel the continuity key names.
 */
export function sessionOpeningFor(deps: SessionOpeningDeps): SessionOpeningFor {
  return (continuityKey, threadContext, audience) => {
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
      // ROME_CHANNEL is the channel the session's turns are delivered on.
      // Shell tools such as the Discord CLI read it to act as that channel's
      // account. Set even when undefined, so a value Rome itself inherited
      // never leaks in. ROME_TURN_AUDIENCE says who can read the session's
      // turns, and the rome-node CLI refuses a device's personal capability
      // while it says shared. A session serves one chat, so it holds for the
      // session's life.
      toolEnv: {
        ROME_CHANNEL: keyChannel,
        ROME_TURN_AUDIENCE: narrowerAudience(turnAudience(threadContext), audience),
      },
      spanAttributes: keyChannel ? { "channel.name": keyChannel } : {},
    };
  };
}

/**
 * The audience a dashboard chat's owner allows: shared for a visitor's chat,
 * or for one Rome cannot find. Undefined for a thread that is no dashboard chat.
 */
export async function dashboardChatAudience(
  webchatRepo: Pick<WebChatRepository, "getSession"> | undefined,
  threadContext: ThreadContext | undefined,
): Promise<Audience | undefined> {
  if (threadContext?.channel !== "webchat") return undefined;
  const chat = threadContext.threadId
    ? await webchatRepo?.getSession(threadContext.threadId)
    : null;
  return chat && (chat.ownerKey ?? "guardian") === "guardian" ? "private" : "shared";
}
