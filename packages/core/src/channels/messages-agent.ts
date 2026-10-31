// Chats' messages as an {@link AccountMessages} store: what Rome was told and
// what it said back in each direct message, for every channel with no mirror
// of its own.

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { MessagePart } from "../types.js";
import type { Message } from "@rome/api-types/message";
import type { AccountMessages, MessageDetail } from "./messages.js";
import type { Account } from "@rome-os/app-runtime";
import { sqlMessages } from "./messages-sql.js";
import { accountTranscript, accountTranscriptDetail } from "../webchat/chat-read-model-sql.js";
import { directMessageAddress, directMessageAt } from "../chats/adapter.js";
import { ChatAddresses } from "./chat-addresses.js";

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
export function agentMessages(
  db: DrizzleDb,
  accountOn: (channel: string) => Account,
): AccountMessages {
  const addresses = new ChatAddresses(db);
  // No `channel`: the transcript holds every channel that has no mirror of its
  // own, side by side, so it is scoped by the pair throughout. A pair names a
  // channel, which is Rome's account on a platform, and the address names the
  // direct message that account has there.
  return sqlMessages({
    db,
    view(scope) {
      if (scope.keys.length === 0) return null;
      return accountTranscript(
        scope.keys.map(({ channel, key }) => {
          const account = accountOn(channel);
          return { channel, account, key, chatId: directMessageAt(account, key, addresses).id };
        }),
      );
    },
    body: messageContentText,
    detail: {
      of: accountTranscriptDetail,
      map: (raw, entry) => transcriptDetail(raw, entry, addresses),
    },
  });
}

/** Who said a transcript line and in which direct message, as the row
 *  recorded them. Rome's own lines carry no sender, the way the sentinel log
 *  reads them. The conversation is named by the address Rome's account
 *  reaches it at. */
function transcriptDetail(
  raw: Record<string, unknown>,
  entry: Message,
  addresses: Pick<ChatAddresses, "addressOf">,
): MessageDetail {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const detail: MessageDetail = {};
  const sender = { id: text(raw.senderId), name: text(raw.senderName) };
  if (entry.direction === "inbound" && (sender.id !== null || sender.name !== null)) {
    detail.sender = sender;
  }
  const chatId = text(raw.chatId);
  const platform = text(raw.platform);
  const accountId = text(raw.accountId);
  if (chatId !== null && platform !== null && accountId !== null) {
    const type = text(raw.threadType);
    detail.conversation = {
      id: directMessageAddress({ platform, id: accountId }, { platform, id: chatId }, addresses),
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
