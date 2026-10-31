import type { ChatLine, ChatRepository } from "@rome-os/app-runtime";

// The connection kinds whose accounts are an agent's own, as each kind's
// descriptor in core declares it (`link: "own_account"`), which an app cannot
// read. A core test keeps the two in step. Every other channel
// carries the guardian's own accounts (a linked WhatsApp, a WeChat login) or
// Rome's own traffic, and stays out of Dream.
export const ACCOUNT_KINDS = ["feishu", "telegram", "discord", "slack_bot"];

/** Connection kinds whose agent is a delegate on the guardian's own account,
 *  which Dream leaves alone as it does their other personal accounts. */
export const GUARDIAN_OWN_KINDS = ["telegram_user"];

/**
 * Whether anyone sent Rome a message in the dashboard's chats or on one of
 * Rome's accounts at or after `since`, which are the chats a dream reads.
 * Agent replies, Rome's own sends, traces, and background sessions (actions,
 * subagents, forks) do not count, so a dream's own session never makes the
 * next one look necessary.
 */
export async function hasChatSince(chats: ChatRepository, since: Date): Promise<boolean> {
  for (const where of ["dashboard", { accountKinds: ACCOUNT_KINDS }] as const) {
    for (const chat of await chats.recentChats({ since, where })) {
      const lines = await chats.transcript(chat.sessionId, { since });
      const heard = (line: ChatLine) =>
        where === "dashboard" ? line.role === "user" : line.role !== "assistant";
      if (lines.some(heard)) return true;
    }
  }
  return false;
}
