// Who a routine from before routines recorded their creator acts for: its
// chat's owner, as its fires did then. Every newer routine records its own
// person (`RoutinesRepository.creatorOf`).

import { actorOfOwner } from "../access/owner-actor.js";
import type { SessionActor } from "../access/session-actor.js";
import { ownerOf } from "../concierge/owner.js";
import type { DrizzleDb } from "../db/index.js";
import type { Routine } from "./types.js";

/**
 * The owner of the chat a legacy routine wakes, as an actor: the owner its
 * wake-up recorded, else the owner of its dashboard chat. Undefined for a
 * routine that names no chat, or one that is gone.
 */
export async function legacyRoutineActor(
  routine: Pick<Routine, "args">,
  deps: {
    db: DrizzleDb;
    webchatRepo: { getSession(id: string): Promise<{ ownerKey?: string | null } | null> };
  },
): Promise<SessionActor | undefined> {
  const { args } = routine;
  let owner: string | null = typeof args.ownerKey === "string" ? args.ownerKey : null;
  if (!owner && args.channel === "webchat" && typeof args.threadId === "string") {
    const chat = await deps.webchatRepo.getSession(args.threadId);
    owner = chat ? ownerOf(chat) : null;
  }
  return owner ? actorOfOwner(deps.db, owner) : undefined;
}
