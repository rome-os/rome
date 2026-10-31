// Chat history as Dream reads it: through the chat repository Rome hands
// apps, never Rome's tables. What a session is (its name, owner, account) is
// still read from `rome_sessions` and `channels`.
import { sql } from "drizzle-orm";
import type { ChatLine, ChatRepository, RomeAppContext } from "@rome-os/app-runtime";

/** A chat with its lines, every one since it started, oldest first. */
export interface ChatHistory {
  sessionId: string;
  name: string;
  lines: ChatLine[];
}

export function chatsOf(appContext: Pick<RomeAppContext, "repositories">): ChatRepository {
  const chats = appContext.repositories.chats ?? appContext.repositories.conversations;
  if (!chats) throw new Error("Rome handed this app no chat repository");
  return chats;
}

/** Said by a visitor on the dashboard. */
export function byVisitor(line: ChatLine): boolean {
  return line.senderId?.startsWith("visitor:") ?? false;
}

/**
 * The guardian's dashboard chats with a line said at or after `since`, or
 * just `sessionId` when it is one, most recently active first. A chat a
 * visitor owns, or one with any request a visitor sent, is left out whole,
 * so Dream never takes someone else's request for the guardian's.
 */
export async function guardianChats(
  appContext: Pick<RomeAppContext, "repositories" | "db">,
  since: Date,
  sessionId?: string,
): Promise<ChatHistory[]> {
  const chats = chatsOf(appContext);
  const recent = await chats.recentChats({ since, where: "dashboard" });
  const ids = sessionId
    ? recent.filter((chat) => chat.sessionId === sessionId).map((chat) => chat.sessionId)
    : recent.map((chat) => chat.sessionId);
  if (ids.length === 0) return [];
  const sessions = appContext.db.connection.all(sql`
    SELECT id, name FROM rome_sessions
    WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
      AND coalesce(owner_key, 'guardian') = 'guardian'
  `) as Array<{ id: string; name: string }>;
  const names = new Map(sessions.map((row) => [row.id, row.name]));
  const histories: ChatHistory[] = [];
  for (const id of ids) {
    const name = names.get(id);
    if (name === undefined) continue;
    const lines = await chats.transcript(id);
    if (lines.some((line) => line.role === "user" && byVisitor(line))) continue;
    histories.push({ sessionId: id, name, lines });
  }
  return histories;
}
