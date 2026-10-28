import { createAppLogger } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  Attachment,
  ChannelMessage,
  ChannelsService,
  ChatId,
} from "@rome-os/app-runtime";
import { addressOf, romeAccountNamed } from "../rome-account.js";

const log = createAppLogger("fetch_channel_history");

/** What a channel query answers when no limit is named. */
const DEFAULT_LIMIT = 100;

/**
 * JSON-safe attachment metadata. Mirrors the subset of {@link Attachment}
 * that is useful to downstream consumers (e.g. fetching a text excerpt from a
 * file URL). The raw `data` Buffer, the channel-specific `rawEvent`, and the
 * server-side `localPath` are intentionally excluded so the payload stays
 * small, serializable, and free of internal filesystem details that would
 * leak into LLM context and prompt logs.
 */
interface StructuredAttachment {
  type: Attachment["type"];
  url?: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
}

/** JSON-safe per-message shape returned only when `includeMessages` is set. */
interface StructuredMessage {
  id: string;
  displayName: string;
  timestamp: string;
  threadId: string;
  threadName?: string;
  text: string;
  attachments: StructuredAttachment[];
}

/**
 * The name a line is shown under. A message names its sender only as the
 * channel recorded them, so the fallbacks for an unnamed one are this tool's,
 * and each channel keeps the ones it has always shown: the guardian's own
 * WhatsApp lines as "You", a WhatsApp group line with no recorded sender as
 * "Unknown", and an unnamed LinkedIn sender as no name at all.
 */
function senderLabel(channel: string, m: ChannelMessage): string {
  if (channel === "whatsapp") {
    if (m.direction === "outbound") return "You";
    return m.senderDisplayName ?? (m.senderId === "" ? "Unknown" : m.senderId);
  }
  if (channel === "linkedin") return m.senderDisplayName ?? "";
  return m.senderDisplayName ?? m.senderId;
}

function toStructuredMessages(channel: string, messages: ChannelMessage[]): StructuredMessage[] {
  return messages.map((m) => ({
    id: m.messageId,
    displayName: senderLabel(channel, m),
    timestamp: m.timestamp.toISOString(),
    threadId: m.chatId,
    threadName: m.thread?.name,
    text: m.text,
    attachments: m.attachments.map((a) => ({
      type: a.type,
      url: a.url,
      mimeType: a.mimeType,
      fileName: a.fileName,
      caption: a.caption,
    })),
  }));
}

function formatMessages(
  channel: string,
  messages: ChannelMessage[],
  since: Date | undefined,
): string {
  if (messages.length === 0) {
    return "(No messages found in the requested window.)";
  }

  // Group by threadName (or threadId as fallback)
  const threads = new Map<string, ChannelMessage[]>();
  for (const msg of messages) {
    const key = msg.thread?.name ?? msg.chatId;
    let bucket = threads.get(key);
    if (!bucket) {
      bucket = [];
      threads.set(key, bucket);
    }
    bucket.push(msg);
  }

  const sections: string[] = [];
  for (const [threadLabel, msgs] of threads) {
    const first = msgs[0];
    const heading =
      first && threadLabel !== first.chatId ? `${threadLabel} (${first.chatId})` : threadLabel;
    const lines = msgs
      .map((m) => {
        const time = m.timestamp.toISOString();
        let text = m.text.trim();
        if (m.attachments.length > 0) {
          const names = m.attachments.map((a) => a.localPath ?? a.fileName ?? a.type).join(", ");
          text = text ? `${text} [attachments: ${names}]` : `[attachments: ${names}]`;
        }
        if (!text) return null;
        return `[${time}] **${senderLabel(channel, m)}**: ${text}`;
      })
      .filter(Boolean);

    if (lines.length > 0) {
      sections.push(`### ${heading}\n\n${lines.join("\n\n")}`);
    }
  }

  const header = since
    ? `## Channel History — ${since.toISOString()} → ${new Date().toISOString()}\n\n`
    : "## Channel History\n\n";

  return sections.length > 0
    ? header + sections.join("\n\n---\n\n")
    : header + "(No readable messages found.)";
}

export function createAction(
  config: ActionConfig,
  deps: { channelsService: ChannelsService },
): Action {
  const { channelsService: channels } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description:
            'The account to read, by the channel a message arrived on, such as "telegram_user", "email" or a Feishu account\'s id. Give this or `platform`.',
        },
        platform: {
          type: "string",
          description:
            'In place of `channel`: read Rome\'s account on this platform, such as "whatsapp" or "email". Refused where Rome holds several accounts there, and the error names their channels.',
        },
        threadId: {
          type: "string",
          description:
            "Optional thread/channel ID to fetch. Omit to fetch all accessible threads (Discord fetches all guild channels).",
        },
        windowHours: {
          type: "number",
          description:
            "How many hours back to fetch messages. Defaults to 24, or to no bound when paging with limit or cursor.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description:
            "How many of the newest messages to return (default 100). Use with cursor to page back a few messages at a time. Paging needs threadId.",
        },
        cursor: {
          type: "string",
          description:
            "The nextCursor a previous call returned: return the messages older than that page.",
        },
        includeMessages: {
          type: "boolean",
          description:
            "When true, also return a structured `messages` array (with per-message attachment metadata: type, url, fileName, mimeType, caption) alongside the markdown `content`. Defaults to false so the default output is unchanged.",
        },
      },
      required: [],
    },

    async execute(args): Promise<ActionResult> {
      const selector = {
        channel: args.channel as string | undefined,
        platform: args.platform as string | undefined,
      };
      const named = selector.channel ?? selector.platform;
      const threadId = (args.threadId as string | undefined) ?? null;
      const limit = args.limit as number | undefined;
      const cursor = args.cursor as string | undefined;
      const paging = limit !== undefined || cursor !== undefined;
      // Paging walks back through one chat; across every chat it has no use.
      if (paging && !threadId) {
        return { status: "error", error: "Paging with limit or cursor needs a threadId." };
      }
      const windowHours = (args.windowHours as number | undefined) ?? (paging ? undefined : 24);
      const since =
        windowHours === undefined ? undefined : new Date(Date.now() - windowHours * 60 * 60 * 1000);
      const includeMessages = args.includeMessages === true;

      const notConfigured: ActionResult = {
        status: "error",
        error: `Channel "${named}" is not configured or not running.`,
      };
      let target: Awaited<ReturnType<typeof romeAccountNamed>>;
      try {
        target = await romeAccountNamed(channels, selector);
      } catch (err) {
        return { status: "error", error: err instanceof Error ? err.message : String(err) };
      }
      if (!target) return notConfigured;
      const channel = target.name;

      log.info("fetching channel history", { channel, threadId, windowHours, limit, paging });

      let messages: ChannelMessage[];
      let nextCursor: string | null = null;
      try {
        const page = await channels.query(addressOf(target), {
          ...(threadId ? { chatId: threadId as ChatId } : {}),
          // With no bound, the epoch: a channel defaults a missing `since` to
          // the last day.
          since: since ?? new Date(0),
          ...(cursor ? { after: cursor } : {}),
          // Named whenever paging, so the page and the full-page check below
          // agree on its size.
          ...(paging ? { limit: limit ?? DEFAULT_LIMIT } : {}),
        });
        // A full page may have older messages behind it; a short one does not.
        if (paging && page.length >= (limit ?? DEFAULT_LIMIT)) {
          nextCursor = page.at(-1)?.cursor ?? null;
        }
        // `query` answers newest first; the transcript reads oldest first.
        messages = page.reverse();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("fetchHistory failed", { channel, error: message });
        // A channel with no store reads through its Connection, and with none
        // connected the service says so (core's `ChannelNotConnected`). That
        // is the case this tool has always answered as not configured; any
        // other failure, a store's included, is reported as it is.
        if (message.startsWith("No connection backs channel")) return notConfigured;
        return {
          status: "error",
          error: `Failed to fetch history from "${channel}": ${message}`,
        };
      }

      log.info("history fetched", { channel, messageCount: messages.length });

      type HistoryData = {
        channel: string;
        messageCount: number;
        windowHours?: number;
        nextCursor?: string | null;
        content: string;
        messages?: StructuredMessage[];
      };

      const data: HistoryData = {
        channel,
        messageCount: messages.length,
        ...(windowHours !== undefined ? { windowHours } : {}),
        // Only a paged read names where the next page starts, so a plain read
        // keeps the payload it always had.
        ...(paging ? { nextCursor } : {}),
        content: formatMessages(channel, messages, since),
      };

      // Opt-in: only add the structured array when explicitly requested, so
      // existing callers (LLM agents, the `dream` action) keep the exact same
      // payload and token footprint they have today.
      if (includeMessages) {
        data.messages = toStructuredMessages(channel, messages);
      }

      return { status: "ok", data };
    },
  };
}
