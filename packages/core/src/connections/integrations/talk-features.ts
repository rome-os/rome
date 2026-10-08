import type { ConversationId, TalkActivity, TalkDirectMessaging } from "@rome-os/app-runtime";

export function historyWindowHours(since?: Date): number {
  if (!since) return 24;
  return Math.max(1, Math.ceil((Date.now() - since.getTime()) / 3_600_000));
}

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 1_000;

export function historyQueryLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), MAX_HISTORY_LIMIT));
}

const MAX_DIRECTORY_OFFSET = 10_000;

export function directoryCursorOffset(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number.isInteger(offset) && offset >= 0 && offset <= MAX_DIRECTORY_OFFSET ? offset : 0;
  } catch {
    return 0;
  }
}

/** Provider-local bounded pagination for integrations whose SDK exposes an
 * in-memory directory rather than a native cursor. */
export function directoryPage<T>(
  items: readonly T[],
  input: { cursor?: string; limit: number },
): { items: T[]; nextCursor?: string } {
  const offset = directoryCursorOffset(input.cursor);
  const limit = Math.max(1, Math.min(input.limit, 10_000));
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    ...(offset + limit < items.length
      ? { nextCursor: Buffer.from(String(offset + limit), "utf8").toString("base64url") }
      : {}),
  };
}

/**
 * Direct messaging for a channel whose direct chat is addressed by the contact
 * themselves — WhatsApp, Telegram — where the account's own address already
 * names the conversation.
 *
 * Costs nothing and cannot fail, so a caller may ask it per account across a
 * whole listing. A channel that keys threads separately writes its own
 * implementation instead, opening or looking up the thread; that one is a
 * provider call and should be priced as one.
 */
export function addressIsConversationFeature(): TalkDirectMessaging {
  return {
    async conversationFor(channelUserId: string) {
      const trimmed = channelUserId.trim();
      return trimmed === "" ? null : (trimmed as ConversationId);
    },
  };
}

export function typingActivityFeature(adapter: {
  notifyTyping(conversationId: string): Promise<void>;
}): TalkActivity {
  return {
    async begin(input) {
      await adapter.notifyTyping(input.conversationId);
      return {
        update: async () => adapter.notifyTyping(input.conversationId),
        finish: async () => {},
      };
    },
  };
}
