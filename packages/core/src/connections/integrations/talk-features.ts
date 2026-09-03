import type {
  Attachment,
  ConversationId,
  InboundMessage,
  MessageReceipt,
  NormalizedMessage,
  TalkActivity,
  TalkDirectMessaging,
  TalkHistory,
  TalkInboundMedia,
} from "@rome-os/app-runtime";

/** Adapters still normalize their provider SDK events into the established
 * internal shape. The integration owns the one-way projection into Talk's
 * provider-neutral contract. */
export function toInboundMessage(message: NormalizedMessage): InboundMessage {
  return {
    messageId: message.id,
    conversationId: message.threadId as ConversationId,
    ...(message.parentThreadId
      ? { parentConversationId: message.parentThreadId as ConversationId }
      : {}),
    senderId: message.channelUserId,
    senderDisplayName: message.displayName,
    text: message.text,
    attachments: message.attachments,
    timestamp: message.timestamp,
    replyTo: message.replyTo,
    ...(message.addressing ? { addressing: message.addressing } : {}),
    thread: {
      kind: message.threadType === "private" ? "dm" : message.parentThreadId ? "topic" : "group",
      ...(message.threadName ? { name: message.threadName } : {}),
    },
    // Only provider-owned semantic features may inspect this value. Generic
    // consumers receive the typed fields above and must leave it untouched.
    raw: message,
  };
}

export function normalizedFromInbound(message: InboundMessage): NormalizedMessage {
  const raw = message.raw;
  if (raw && typeof raw === "object" && "channel" in raw && "rawEvent" in raw) {
    return raw as NormalizedMessage;
  }
  throw new Error("Inbound message does not carry its provider materialization token");
}

export function toMessageReceipt(
  conversationId: ConversationId,
  result: {
    messageId?: string;
    threadId?: string;
    parts?: Array<{ messageId: string; kind: string }>;
  } | void,
): MessageReceipt {
  return {
    conversationId: (result?.threadId ?? conversationId) as ConversationId,
    ...(result?.messageId ? { messageId: result.messageId } : {}),
    ...(result?.parts ? { parts: result.parts } : {}),
  };
}

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

export function inboundMediaFeature(adapter: {
  saveIncomingAttachments(message: NormalizedMessage): Promise<Attachment[]>;
}): TalkInboundMedia {
  return {
    materialize: (message) => adapter.saveIncomingAttachments(normalizedFromInbound(message)),
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

export function historyFeature(adapter: {
  fetchHistory(conversationId: string | null, windowHours: number): Promise<NormalizedMessage[]>;
}): TalkHistory {
  return {
    async query(input) {
      const messages = await adapter.fetchHistory(
        input.conversationId ?? null,
        historyWindowHours(input.since),
      );
      return messages.slice(0, historyQueryLimit(input.limit)).map(toInboundMessage);
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
