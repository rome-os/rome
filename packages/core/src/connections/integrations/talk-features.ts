import type { ChatId, ChannelActivity, ChannelDirectMessaging } from "@rome-os/app-runtime";

const MAX_DIRECTORY_OFFSET = 10_000;

/** The offset a directory cursor names. A cursor past `max`, the deepest
 *  offset a directory fetches to, throws, since starting over would list the
 *  same chats again. */
export function directoryCursorOffset(cursor?: string, max = MAX_DIRECTORY_OFFSET): number {
  if (!cursor) return 0;
  let offset: number;
  try {
    offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return 0;
  }
  if (!Number.isInteger(offset) || offset < 0) return 0;
  if (offset > max) {
    throw new Error(`A directory lists at most ${max} conversations by paging`);
  }
  return offset;
}

/** Provider-local bounded pagination for integrations whose SDK exposes an
 * in-memory directory rather than a native cursor. The directory is already
 * in memory, so every cursor it hands out pages on, however deep. */
export function directoryPage<T>(
  items: readonly T[],
  input: { cursor?: string; limit: number },
): { items: T[]; nextCursor?: string } {
  const offset = directoryCursorOffset(input.cursor, Number.MAX_SAFE_INTEGER);
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
export function addressIsConversationFeature(): Pick<ChannelDirectMessaging, "chatFor"> {
  return {
    async chatFor(channelUserId: string) {
      const trimmed = channelUserId.trim();
      return trimmed === "" ? null : (trimmed as ChatId);
    },
  };
}

export function typingActivityFeature(adapter: {
  notifyTyping(chatId: string): Promise<void>;
}): ChannelActivity {
  return {
    async begin(input) {
      await adapter.notifyTyping(input.chatId);
      return {
        update: async () => adapter.notifyTyping(input.chatId),
        finish: async () => {},
      };
    },
  };
}
