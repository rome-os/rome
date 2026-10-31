// Chats' messages as an {@link AccountMessages} store: what Rome was told and
// what it said back in each direct message, for every channel with no mirror
// of its own.

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { MessagePart } from "../types.js";
import type { Message } from "@rome/api-types/message";
import type { AccountMessages, MessageDetail } from "./messages.js";
import { scopePairs, sqlMessages } from "./messages-sql.js";
import { accountTranscript, accountTranscriptDetail } from "../webchat/chat-read-model-sql.js";

/**
 * Rome's own transcript of a channel conversation, read for accounts.
 *
 * Reached through the session's thread. A channel session is keyed by the
 * thread it belongs to, so a session addressed by the account is that account's
 * direct conversation. A group's session is addressed by the group rather than
 * by anyone on it, so no account names it. Which sender a message carries makes
 * no difference: a line the account wrote into a group belongs to the group's
 * thread.
 */
export function agentMessages(db: DrizzleDb): AccountMessages {
  // No `channel`: the transcript holds every channel that has no mirror of its
  // own, side by side, so it is scoped by the pair throughout.
  return sqlMessages({
    db,
    view(scope) {
      const addressed = scopePairs(scope.keys, sql`s.source_channel`, sql`s.source_thread_id`);
      if (addressed === null) return null;
      // Addressing already leaves a group out, since a group's session is keyed
      // by the group and no account answers to that. Said again on the store's
      // own terms so the guarantee survives a caller that hands over a group id
      // as if it were an account's address.
      const held = sql`${addressed} AND c.kind = 'dm'`;
      return accountTranscript(held);
    },
    body: messageContentText,
    detail: {
      of: accountTranscriptDetail,
      map: transcriptDetail,
    },
  });
}

/** Who said a transcript line and in which session's thread, as the row
 *  recorded them. Rome's own lines carry no sender, the way the sentinel log
 *  reads them. A private thread is a direct one, and a thread type with no kind
 *  of its own reads as unknown. */
function transcriptDetail(raw: Record<string, unknown>, entry: Message): MessageDetail {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const detail: MessageDetail = {};
  const sender = { id: text(raw.senderId), name: text(raw.senderName) };
  if (entry.direction === "inbound" && (sender.id !== null || sender.name !== null)) {
    detail.sender = sender;
  }
  const threadId = text(raw.threadId);
  if (threadId !== null) {
    const type = text(raw.threadType);
    detail.conversation = {
      id: threadId,
      name: text(raw.threadName),
      kind: type === "private" ? "dm" : type === "group" || type === "topic" ? type : null,
    };
  }
  return detail;
}

/** The line a stored agent message renders as: its text parts, joined.
 *  Non-text parts (cards, recaps, errors) carry no conversation, nor does a
 *  dashboard turn's narration on its way to the answer (a commentary part).
 *  Content that does not parse is a row with nothing to show rather than a
 *  failed read. */
export function messageContentText(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const text = parsed
    .filter((part): part is Extract<MessagePart, { type: "text" }> => {
      if (typeof part !== "object" || part === null) return false;
      const candidate = part as { type?: unknown; content?: unknown; turnPhase?: unknown };
      return (
        candidate.type === "text" &&
        typeof candidate.content === "string" &&
        candidate.turnPhase !== "commentary"
      );
    })
    .map((part) => part.content)
    .join("\n");
  return text.length > 0 ? text : null;
}
