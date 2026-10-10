import type { ChannelMessage, ConversationId, MessageReceipt } from "@rome-os/app-runtime";
import type { OutgoingMessage } from "./types.js";
import type { StoredWebchatHistoryMessage, WebChatRepository } from "../db/repositories/webchat.js";
import type { MessagePart } from "../types.js";
import { v4 as uuid } from "uuid";
import { createLogger } from "../logger.js";
import { artifactLocalName, isCoreMainAgentId } from "../apps/artifact-id.js";
import { DEFAULT_BOT_DISPLAY_NAME } from "./mention-only.js";

const log = createLogger("webchat");
const DEFAULT_HISTORY_WINDOW_HOURS = 24;
export const WEBCHAT_GUARDIAN_USER_ID = "guardian";

function prettyAgentName(name: string | null): string {
  if (!name || isCoreMainAgentId(name)) return DEFAULT_BOT_DISPLAY_NAME;
  return artifactLocalName(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isMessagePart(value: unknown): value is MessagePart {
  return Boolean(value && typeof value === "object" && "type" in value);
}

function messagePartText(part: MessagePart): string | null {
  switch (part.type) {
    case "text":
    case "turn_recap":
      return part.content;
    default:
      return null;
  }
}

function contentToText(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!Array.isArray(parsed)) return content;

  return parsed
    .filter(isMessagePart)
    .map(messagePartText)
    .filter((text): text is string => Boolean(text?.trim()))
    .join("\n");
}

/**
 * The in-process WebChat transport. It persists outbound replies and reads
 * session history as the channel's own record, a `ChannelMessage` whose `raw`
 * is the stored history row.
 */
export class WebChatAdapter {
  private messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;

  constructor(private webchatRepo: WebChatRepository) {}

  async start(): Promise<void> {
    log.info("webchat adapter started");
  }

  async stop(): Promise<void> {
    log.info("webchat adapter stopped");
  }

  /** Persist an assistant reply into the session. A message with no text,
   *  parts or attachments writes nothing, and its receipt has no `messageId`. */
  async send(conversationId: ConversationId, message: OutgoingMessage): Promise<MessageReceipt> {
    const threadId: string = conversationId;
    const parts =
      message.parts && message.parts.length > 0
        ? message.parts
        : message.text
          ? [{ type: "text" as const, content: message.text }]
          : [];

    for (const att of message.attachments ?? []) {
      const label = att.caption ? `${att.caption}: ${att.source}` : att.source;
      parts.push({ type: "text" as const, content: `[${att.type}] ${label}` });
    }

    if (parts.length === 0) return { conversationId };

    const messageId = uuid();
    await this.webchatRepo.addSentMessage(messageId, threadId, parts, message.turnId ?? null);
    log.info("webchat message persisted", { threadId });
    return { conversationId, messageId };
  }

  onInbound(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /** The guardian's and the agents' lines in one session, or in every
   *  top-level webchat session when `threadId` is null, oldest first. A line
   *  the guardian did not write is `outbound`. A line with no text is left
   *  out. */
  async fetchHistory(threadId: string | null, windowHours: number): Promise<ChannelMessage[]> {
    const safeWindowHours =
      Number.isFinite(windowHours) && windowHours > 0 ? windowHours : DEFAULT_HISTORY_WINDOW_HOURS;
    const since = new Date(Date.now() - safeWindowHours * 60 * 60 * 1000);
    const rows = await this.webchatRepo.getHistoryMessages(threadId, since);
    return rows.map((row) => this.historyRowToMessage(row)).filter((msg) => msg.text.trim());
  }

  private historyRowToMessage(row: StoredWebchatHistoryMessage): ChannelMessage {
    const isUser = row.role === "user";
    const senderId = isUser ? WEBCHAT_GUARDIAN_USER_ID : (row.sessionAgentName ?? "main");
    return {
      channel: "webchat",
      direction: senderId === WEBCHAT_GUARDIAN_USER_ID ? "inbound" : "outbound",
      messageId: row.id,
      conversationId: row.sessionId as ConversationId,
      senderId,
      senderDisplayName: isUser ? "Guardian" : prettyAgentName(row.sessionAgentName),
      text: contentToText(row.content),
      attachments: [],
      timestamp: row.createdAt,
      thread: {
        kind: "dm",
        ...(row.sessionName ? { name: row.sessionName } : {}),
      },
      raw: row,
    };
  }
}
