// Who can read a chat: the one rule core reads a turn's audience from, for
// agent actions, routines and an agent's shell. Domain:
// docs/domains/participation.md#audience.

import type { ThreadContext } from "@rome-os/app-runtime";
import { type Audience, messagingAudience } from "../agent/index.js";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import { type ChatPrivacyRow, privateOwnerOf } from "../webchat/privacy.js";
import { GUARDIAN_OWNER, ownerOf } from "../webchat/owner.js";

/** Who can read the chat a thread context names: who it is said in, and who
 *  can read it where Rome records it. */
export type PlaceAudience = (context: ThreadContext | undefined) => Promise<Audience>;

export interface PlaceAudienceDeps {
  /** The connection kind behind a channel id. Absent, a channel id reads as its own kind. */
  connectionKindOf?: ConnectionKindOfChannel;
  /** A dashboard chat's row. Absent, every dashboard chat is shared. */
  dashboardChat?: (chatId: string) => Promise<ChatPrivacyRow | null>;
  /** Whether anyone besides the guardian may open the dashboard. Absent, someone may. */
  visitorsAllowed?: () => boolean;
}

/**
 * Who can read a dashboard chat. A chat private to the guardian (their
 * Concierge's chats, its task chats and their children) is private. Every
 * other dashboard chat opens for every dashboard user, so it is private only
 * while nobody but the guardian may open the dashboard.
 */
export function dashboardChatAudience(
  chat: ChatPrivacyRow | null,
  visitorsAllowed: boolean,
): Audience {
  if (!chat) return "shared";
  const privateTo = privateOwnerOf(chat);
  if (privateTo !== null) return privateTo === GUARDIAN_OWNER ? "private" : "shared";
  return ownerOf(chat) === GUARDIAN_OWNER && !visitorsAllowed ? "private" : "shared";
}

export function placeAudience(deps: PlaceAudienceDeps): PlaceAudience {
  return async (context) => {
    if (!context) return "shared";
    if (context.channel === "webchat") {
      const chat =
        context.threadId && deps.dashboardChat ? await deps.dashboardChat(context.threadId) : null;
      return dashboardChatAudience(chat, deps.visitorsAllowed?.() ?? true);
    }
    const kind = deps.connectionKindOf?.(context.channel) ?? context.channel;
    // A connected account's chat is recorded where every dashboard user can
    // read it, so its direct message is private only while nobody but the
    // guardian may open the dashboard.
    if (deps.visitorsAllowed?.() ?? true) return "shared";
    return messagingAudience(context, kind);
  };
}
