import type { SessionSurface, SurfaceKeeps } from "../agent-sessions/index.js";
import { isGuardianFacingChannel } from "../core/guardian-channel.js";
import { callerConnection, type SessionCaller } from "../core/session-caller.js";
import type { ThreadContext } from "../core/types.js";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import { WEBCHAT_CHANNEL, WEBCHAT_SURFACE } from "../chats/dashboard/dashboard-account.js";

/** The parts of a channel's surface that change how its sessions prompt. */
export interface ChannelSurface {
  /** The next human turn arrives on a surface that renders interactive cards. */
  interactiveCards: boolean;
  /** Prompts carry the stored messages the agent has not seen. */
  promptContext: boolean;
}

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

function dashboardOnly(channel: string): ChannelSurface | null {
  return channel === WEBCHAT_CHANNEL ? WEBCHAT_SURFACE : null;
}

export interface SurfaceDeps {
  /** What the named channel's surface supports, or null for a name no channel
   *  has. A null result reads as a messaging channel. Absent, only the
   *  dashboard chat renders cards. */
  channelSurface?: (channel: string) => ChannelSurface | null;
  connectionKindOfChannel?: ConnectionKindOfChannel;
}

/**
 * The surface a caller lends its session: cards when the channel the turn
 * replies on renders them, a wake-up when the caller is on a guardian-facing
 * connection.
 */
export function sessionSurfaceOf(
  deps: SurfaceDeps,
  caller: SessionCaller | undefined,
  replies: ThreadContext | undefined,
  extra: { keeps?: SurfaceKeeps; about?: string } = {},
): SessionSurface {
  // An opener without a reply address falls back to the channel the caller names.
  const channel = replies?.channel ?? (caller ? callerConnection(caller) : undefined);
  const cards =
    !!channel &&
    ((deps.channelSurface ?? dashboardOnly)(channel) ?? MESSAGING_CHANNEL_SURFACE).interactiveCards;
  // A resume that names no caller is woken where it replies.
  const wakeChannel = caller ? callerConnection(caller) : replies?.channel;
  const wake = !!wakeChannel && isGuardianFacingChannel(wakeChannel, deps.connectionKindOfChannel);
  return {
    cards,
    ...(replies ? { replies } : {}),
    ...(wake ? { wake: true } : {}),
    ...(extra.keeps ? { keeps: extra.keeps } : {}),
    ...(extra.about ? { about: extra.about } : {}),
  };
}

/** Whether the surface at `replies` writes the turn's prompt and answer
 *  itself. The dashboard chat's route writes its own lines as it streams;
 *  the session's log keeps the trace either way. */
export function surfaceKeepsLines(replies?: ThreadContext): boolean {
  return replies?.channel === WEBCHAT_CHANNEL;
}
