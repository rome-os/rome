import { createAppLogger, WHATSAPP_UNKNOWN_SENDER } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  Attachment,
  ChannelMessage,
  ConversationId,
  TalkRouter,
} from "@rome-os/app-runtime";

const log = createAppLogger("fetch_channel_history");

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
    return m.senderDisplayName ?? (m.senderId === WHATSAPP_UNKNOWN_SENDER ? "Unknown" : m.senderId);
  }
  if (channel === "linkedin") return m.senderDisplayName ?? "";
  return m.senderDisplayName ?? m.senderId;
}

function toStructuredMessages(channel: string, messages: ChannelMessage[]): StructuredMessage[] {
  return messages.map((m) => ({
    id: m.messageId,
    displayName: senderLabel(channel, m),
    timestamp: m.timestamp.toISOString(),
    threadId: m.conversationId,
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

function formatMessages(channel: string, messages: ChannelMessage[], windowHours: number): string {
  if (messages.length === 0) {
    return "(No messages found in the requested window.)";
  }

  // Group by threadName (or threadId as fallback)
  const threads = new Map<string, ChannelMessage[]>();
  for (const msg of messages) {
    const key = msg.thread?.name ?? msg.conversationId;
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
      first && threadLabel !== first.conversationId
        ? `${threadLabel} (${first.conversationId})`
        : threadLabel;
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

  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const header = `## Channel History — ${cutoff} → ${now}\n\n`;

  return sections.length > 0
    ? header + sections.join("\n\n---\n\n")
    : header + "(No readable messages found.)";
}

export function createAction(config: ActionConfig, deps: { talkRouter: TalkRouter }): Action {
  const { talkRouter } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description:
            'Channel name, e.g. "discord", "telegram", "telegram_user", "whatsapp", "wechat", "email"',
        },
        threadId: {
          type: "string",
          description:
            "Optional thread/channel ID to fetch. Omit to fetch all accessible threads (Discord fetches all guild channels).",
        },
        windowHours: {
          type: "number",
          description: "How many hours back to fetch messages (default: 24)",
        },
        includeMessages: {
          type: "boolean",
          description:
            "When true, also return a structured `messages` array (with per-message attachment metadata: type, url, fileName, mimeType, caption) alongside the markdown `content`. Defaults to false so the default output is unchanged.",
        },
      },
      required: ["channel"],
    },

    async execute(args): Promise<ActionResult> {
      const channel = args.channel as string;
      const threadId = (args.threadId as string | undefined) ?? null;
      const windowHours = (args.windowHours as number | undefined) ?? 24;
      const includeMessages = args.includeMessages === true;

      const connections = (await talkRouter.list()).filter((item) => item.service === channel);
      if (connections.length === 0) {
        return {
          status: "error",
          error: `Channel "${channel}" is not configured or not running.`,
        };
      }

      if (connections.length > 1) {
        return {
          status: "error",
          error: `Channel "${channel}" has multiple connections; connectionId is required.`,
        };
      }
      const history = talkRouter.feature(connections[0]!.connectionId, "history");
      if (!history) {
        return {
          status: "error",
          error: `Channel "${channel}" does not support history fetching.`,
        };
      }

      log.info("fetching channel history", { channel, threadId, windowHours });

      let messages: ChannelMessage[];
      try {
        messages = await history.query({
          ...(threadId ? { conversationId: threadId as ConversationId } : {}),
          since: new Date(Date.now() - windowHours * 60 * 60 * 1000),
        });
      } catch (err) {
        log.error("fetchHistory failed", {
          channel,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          status: "error",
          error: `Failed to fetch history from "${channel}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      log.info("history fetched", { channel, messageCount: messages.length });

      type HistoryData = {
        channel: string;
        messageCount: number;
        windowHours: number;
        content: string;
        messages?: StructuredMessage[];
      };

      const data: HistoryData = {
        channel,
        messageCount: messages.length,
        windowHours,
        content: formatMessages(channel, messages, windowHours),
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
