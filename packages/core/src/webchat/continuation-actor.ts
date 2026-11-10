// Who a continuation acts for: the person whose turn it continues.
// A turn that held more than one person's input stays acting for no one.

import { actorOfOwner } from "../access/owner-actor.js";
import type { SessionActor } from "../access/session-actor.js";
import type { DrizzleDb } from "../db/index.js";
import type { InterruptedTurn } from "../db/repositories/webchat.js";
import type { ChatsWebChatRepository } from "./chats-webchat-repository.js";

/** The actor a restart or usage-limit continuation of `turn` runs as, or undefined for no one. */
export async function continuationActor(
  db: DrizzleDb,
  repo: Pick<ChatsWebChatRepository, "getTurnPromptSenders">,
  turn: Pick<InterruptedTurn, "sessionId" | "turnId">,
): Promise<SessionActor | undefined> {
  const senders = repo.getTurnPromptSenders(turn);
  return senders.length === 1 ? actorOfOwner(db, senders[0]) : undefined;
}
