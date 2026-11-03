import type { ChatId, ChannelActivity, ChannelDirectMessaging } from "@rome-os/app-runtime";

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
