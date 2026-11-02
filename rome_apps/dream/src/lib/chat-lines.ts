// Chat history as Dream reads it: through the chat repository Rome hands
// apps, never Rome's tables.
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
  appContext: Pick<RomeAppContext, "repositories">,
  since: Date,
  sessionId?: string,
): Promise<ChatHistory[]> {
  const chats = chatsOf(appContext);
  const recent = (await chats.recentChats({ since, where: "dashboard" })).filter(
    (chat) =>
      chat.ownerKey === "guardian" && (sessionId === undefined || chat.sessionId === sessionId),
  );
  const histories: ChatHistory[] = [];
  for (const { sessionId: id, name } of recent) {
    const lines = await chats.transcript(id);
    if (lines.some((line) => line.role === "user" && byVisitor(line))) continue;
    histories.push({ sessionId: id, name, lines });
  }
  return histories;
}
