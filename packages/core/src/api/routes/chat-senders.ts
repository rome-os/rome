import type { ChatMessageSender } from "@rome/api-types/chat";
import { guardianAuth } from "../../db/schema.js";
import { VisitorProfilesRepository } from "../../db/repositories/visitor-profiles.js";
import type { SessionActor } from "../../lib/session-actor.js";
import type { ApiDeps } from "../deps.js";

/**
 * Turn each message's recorded actor into the sender the dashboard shows. The
 * name and picture are read now, not when the message was sent, so a new
 * picture shows on old messages too.
 */
export async function resolveChatSenders(
  deps: Pick<ApiDeps, "db" | "settingsRepo">,
  actors: ReadonlyMap<string, SessionActor>,
): Promise<Map<string, ChatMessageSender>> {
  const senders = new Map<string, ChatMessageSender>();
  if (actors.size === 0) return senders;

  const list = [...actors.values()];
  const visitorIds = [
    ...new Set(list.flatMap((actor) => (actor.kind === "visitor" ? [actor.accountId] : []))),
  ];
  const profiles = await new VisitorProfilesRepository(deps.db).getMany(visitorIds);

  let guardian: ChatMessageSender | null = null;
  if (list.some((actor) => actor.kind === "guardian")) {
    const name = await deps.settingsRepo.get("guardianName");
    const [seat] = await deps.db
      .select({ email: guardianAuth.email, avatarUrl: guardianAuth.avatarUrl })
      .from(guardianAuth)
      .limit(1);
    guardian = {
      kind: "guardian",
      name: typeof name === "string" && name ? name : (seat?.email ?? null),
      avatarUrl: seat?.avatarUrl ?? null,
    };
  }

  for (const [messageId, actor] of actors) {
    if (actor.kind === "guardian" && guardian) {
      senders.set(messageId, guardian);
    } else if (actor.kind === "visitor") {
      const profile = profiles.get(actor.accountId);
      senders.set(messageId, {
        kind: "visitor",
        accountId: actor.accountId,
        name: profile?.email ?? actor.email,
        avatarUrl: profile?.avatarUrl ?? null,
      });
    }
  }
  return senders;
}
