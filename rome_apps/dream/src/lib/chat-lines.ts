// Chat history as Dream reads it through the chat reads Rome hands apps.
import type { RomeAppContext } from "@rome-os/app-runtime";
import type { ChatLine, ChatReads } from "@rome-os/app-runtime/chats";
import { ACCOUNT_KINDS } from "./chat-activity.js";

/** A chat with its lines, every one since it started, oldest first. */
export interface ChatHistory {
  sessionId: string;
  name: string;
  lines: ChatLine[];
}

/** The chat reads Rome hands this app. Dream reads chats only through them,
 *  so a host that offers none fails the run rather than reading nothing. */
export function chatReadsOf(appContext: Pick<RomeAppContext, "repositories">): ChatReads {
  const chats = appContext.repositories?.chats;
  if (!chats?.recentChats || !chats.transcript || !chats.traces) {
    throw new Error("Dream reads chats through Chats, and this host offers no chat reads");
  }
  return {
    recentChats: chats.recentChats.bind(chats),
    transcript: chats.transcript.bind(chats),
    traces: chats.traces.bind(chats),
  };
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
  reads: ChatReads,
  since: Date,
  sessionId?: string,
): Promise<ChatHistory[]> {
  const recent = (await reads.recentChats({ since, where: "dashboard" })).filter(
    (chat) =>
      chat.ownerKey === "guardian" && (sessionId === undefined || chat.sessionId === sessionId),
  );
  const histories: ChatHistory[] = [];
  for (const { sessionId: id, name } of recent) {
    const lines = await reads.transcript(id);
    if (lines.some((line) => line.role === "user" && byVisitor(line))) continue;
    histories.push({ sessionId: id, name, lines });
  }
  return histories;
}

/**
 * Whether anyone sent Rome a message at or after `since` in the dashboard's
 * chats or on one of Rome's accounts. Chats reads every line Rome sent as
 * `assistant`, so on an account any other line was heard.
 */
export async function heardSince(reads: ChatReads, since: Date): Promise<boolean> {
  const scopes = [
    { where: "dashboard" as const, heard: (line: ChatLine) => line.role === "user" },
    {
      where: { accountKinds: ACCOUNT_KINDS },
      heard: (line: ChatLine) => line.role !== "assistant",
    },
  ];
  for (const { where, heard } of scopes) {
    for (const chat of await reads.recentChats({ since, where })) {
      if ((await reads.transcript(chat.sessionId, { since })).some(heard)) return true;
    }
  }
  return false;
}
