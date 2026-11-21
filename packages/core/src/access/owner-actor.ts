// A person, named by the owner key a chat or message records ("guardian" or
// "visitor:<account>"), as the actor work done for them runs as.

import type { DrizzleDb } from "../db/index.js";
import { guardianActor, type SessionActor } from "./session-actor.js";
import { VisitorProfilesRepository } from "./visitor-profiles.js";

const VISITOR_PREFIX = "visitor:";

/** The actor for `owner`, or undefined for a key that names no person, or a guardian with no seat yet. */
export async function actorOfOwner(
  db: DrizzleDb,
  owner: string,
): Promise<SessionActor | undefined> {
  if (owner === "guardian") return guardianActor(db);
  if (!owner.startsWith(VISITOR_PREFIX)) return undefined;
  const accountId = owner.slice(VISITOR_PREFIX.length);
  const profiles = await new VisitorProfilesRepository(db).getMany([accountId]);
  return { kind: "visitor", accountId, email: profiles.get(accountId)?.email ?? "" };
}
