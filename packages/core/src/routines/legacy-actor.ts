// Who a routine from before routines recorded their creator acts for: its
// chat's owner, as its fires did then. Every newer routine records its own
// person (`Routine.createdBy`).

import { guardianActor, type SessionActor } from "../access/session-actor.js";
import { VisitorProfilesRepository } from "../access/visitor-profiles.js";
import { ownerOf, recipientOf } from "../concierge/owner.js";
import type { DrizzleDb } from "../db/index.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { Routine } from "./types.js";

/**
 * The owner of the chat a legacy routine wakes, as an actor: the owner its
 * wake-up recorded, else the owner of its dashboard chat. Undefined for a
 * routine that names no chat, or one that is gone.
 */
export async function legacyRoutineActor(
  routine: Pick<Routine, "args">,
  deps: { db: DrizzleDb; webchatRepo: Pick<WebChatRepository, "getSession"> },
): Promise<SessionActor | undefined> {
  const { args } = routine;
  let owner: string | null = typeof args.ownerKey === "string" ? args.ownerKey : null;
  if (!owner && args.channel === "webchat" && typeof args.threadId === "string") {
    const chat = await deps.webchatRepo.getSession(args.threadId);
    owner = chat ? ownerOf(chat) : null;
  }
  if (!owner) return undefined;
  const accountId = recipientOf(owner);
  if (accountId === undefined) return guardianActor(deps.db);
  const profiles = await new VisitorProfilesRepository(deps.db).getMany([accountId]);
  return { kind: "visitor", accountId, email: profiles.get(accountId)?.email ?? "" };
}
