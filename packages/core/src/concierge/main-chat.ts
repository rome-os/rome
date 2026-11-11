// Each owner's main Concierge chat: its id and the name it is created with.

import { createHash } from "node:crypto";
import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { type ConciergeOwner, GUARDIAN_OWNER, ownerOf } from "../webchat/owner.js";
import { isConciergeChat } from "../webchat/privacy.js";

/** The name a main chat is created with. A client labels it by `main: true`. */
export const MAIN_CHAT_NAME = "Main chat";

/**
 * The id of an owner's main Concierge chat. The guardian's is the fixed
 * `concierge`. A visitor's is derived from their owner key, since a chat id
 * may hold neither ":" (session keys are split on it) nor anything a live
 * topic name refuses.
 */
export function mainChatIdOf(owner: ConciergeOwner): string {
  if (owner === GUARDIAN_OWNER) return CONCIERGE_CHAT_ID;
  return `concierge-v-${createHash("sha256").update(owner).digest("hex").slice(0, 24)}`;
}

/** Whether a chat is its owner's main Concierge chat. */
export function isMainConciergeChat(chat: {
  id: string;
  agentName?: string | null;
  ownerKey?: string | null;
}): boolean {
  return isConciergeChat(chat) && chat.id === mainChatIdOf(ownerOf(chat));
}
