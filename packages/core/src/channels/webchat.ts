import type { ProviderAdapter } from "./adapter.js";
import type { NormalizedMessage, OutgoingMessage } from "./types.js";
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

export class WebChatAdapter implements ProviderAdapter {
  readonly channelName = "webchat";
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;

  constructor(private webchatRepo: WebChatRepository) {}

  async start(): Promise<void> {
    log.info("webchat adapter started");
  }

  async stop(): Promise<void> {
    log.info("webchat adapter stopped");
  }

  async sendMessage(channelUserId: string, threadId: string, message: OutgoingMessage) {
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

    if (parts.length === 0) return;

    const content = JSON.stringify(parts);
    const messageId = uuid();
    await this.webchatRepo.addMessage(
      messageId,
      threadId,
      "assistant",
      content,
      message.turnId ?? null,
    );
    log.info("webchat message persisted", { threadId, channelUserId });
    return { messageId, threadId };
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async fetchHistory(threadId: string | null, windowHours: number): Promise<NormalizedMessage[]> {
    const safeWindowHours =
      Number.isFinite(windowHours) && windowHours > 0 ? windowHours : DEFAULT_HISTORY_WINDOW_HOURS;
    const since = new Date(Date.now() - safeWindowHours * 60 * 60 * 1000);
    const rows = await this.webchatRepo.getHistoryMessages(threadId, since);
    return rows.map((row) => this.historyRowToNormalized(row)).filter((msg) => msg.text.trim());
  }

  private historyRowToNormalized(row: StoredWebchatHistoryMessage): NormalizedMessage {
    const isUser = row.role === "user";
    const channelUserId = isUser ? WEBCHAT_GUARDIAN_USER_ID : (row.sessionAgentName ?? "main");
    return {
      id: row.id,
      channel: "webchat",
      channelUserId,
      displayName: isUser ? "Guardian" : prettyAgentName(row.sessionAgentName),
      threadId: row.sessionId,
      threadName: row.sessionName,
      threadType: "private",
      timestamp: row.createdAt,
      text: contentToText(row.content),
      attachments: [],
      rawEvent: row,
    };
  }
}
