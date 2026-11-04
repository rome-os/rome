import type { ChannelMessage, ChatId, MessageReceipt } from "@rome-os/app-runtime";
import type { OutgoingMessage } from "../../types.js";
import type {
  StoredWebchatHistoryMessage,
  WebChatRepository,
} from "../../db/repositories/webchat.js";
import type { MessagePart } from "../../types.js";
import { v4 as uuid } from "uuid";
import { createLogger } from "../../logger.js";
import { ChannelSendRefused } from "@rome-os/app-runtime";
import { withoutHostOnlyParts } from "../host-only-parts.js";
import { artifactLocalName, isCoreMainAgentId } from "../../apps/artifact-id.js";
import { DEFAULT_BOT_DISPLAY_NAME } from "../../participation/mention-only.js";

const log = createLogger("webchat");
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
 * The in-process WebChat transport. It persists outbound replies;
 * {@link readWebchatMessages} reads them back.
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

  /** Persist an assistant reply into the session. A message that shows
   *  nothing, with no nonblank text, no other part and no attachment, is
   *  refused and writes nothing. */
  async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
    const threadId: string = chatId;
    // Only the host authors routine cards, and it writes them to the
    // repository itself (see host-only-parts.ts), so a sender's is refused.
    const given = withoutHostOnlyParts(message.parts ?? []);
    if (message.parts && given.length < message.parts.length) {
      throw new ChannelSendRefused(
        "part_unsupported",
        "Only Rome itself shows a routine_draft_card on the dashboard",
      );
    }
    const shown = given.filter((part) => part.type !== "text" || part.content.trim());
    // `text` that says anything is what is said, in place of the text parts,
    // as on every channel; the other parts show beside it. Text parts that
    // say the same are kept, since they carry each block's place in the turn.
    const said = message.text?.trim() ? message.text : undefined;
    const partsSay = shown.flatMap((part) => (part.type === "text" ? [part.content] : []));
    const parts =
      said === undefined || partsSay.join("\n\n").trim() === said.trim()
        ? shown
        : [
            { type: "text" as const, content: said },
            ...shown.filter((part) => part.type !== "text"),
          ];

    for (const att of message.attachments ?? []) {
      const label = att.caption ? `${att.caption}: ${att.source}` : att.source;
      parts.push({ type: "text" as const, content: `[${att.type}] ${label}` });
    }

    if (parts.length === 0) {
      throw new ChannelSendRefused(
        "empty",
        "A dashboard message needs text, parts or an attachment",
      );
    }

    const messageId = uuid();
    await this.webchatRepo.addSentMessage(messageId, threadId, parts, message.turnId ?? null);
    log.info("webchat message persisted", { threadId });
    return { chatId, messageId };
  }

  onInbound(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }
}

/** The guardian's and the agents' lines at or after `since` in one session,
 *  or in every top-level webchat session when `chatId` is null, oldest first.
 *  A line the guardian did not write is `outbound`. A line with no text is
 *  left out. */
export async function readWebchatMessages(
  webchatRepo: WebChatRepository,
  chatId: string | null,
  since: Date,
): Promise<ChannelMessage[]> {
  const rows = await webchatRepo.getHistoryMessages(chatId, since);
  return rows.map(historyRowToMessage).filter((msg) => msg.text.trim());
}

function historyRowToMessage(row: StoredWebchatHistoryMessage): ChannelMessage {
  const isUser = row.role === "user";
  const senderId = isUser ? WEBCHAT_GUARDIAN_USER_ID : (row.sessionAgentName ?? "main");
  return {
    channel: "webchat",
    direction: senderId === WEBCHAT_GUARDIAN_USER_ID ? "inbound" : "outbound",
    messageId: row.id,
    chatId: row.sessionId as ChatId,
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
