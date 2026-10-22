// The host side of a channel-message hook's `recordChatMessage`. A message the
// chat's reply rule declined becomes a notification row in the chat's
// transcript, in this process: context for the next turn, starting none. The
// inbox app's `message_handler` stores the same row through an action on a
// host that predates this port, so the row's shape matches its `answer: false`
// branch field for field.

import type {
  Attachment,
  PolicyContext,
  PolicyRule,
  RecordChatMessageHandler,
} from "@rome-os/app-runtime";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";

const log = createLogger("record-chat-message");

export interface ChatMessageRecorderDeps {
  findPerson(
    channel: string,
    channelUserId: string,
  ): Promise<{ id: string; bondLevel: string } | null | undefined>;
  evaluatePolicy(context: PolicyContext): Promise<PolicyRule>;
  chats: Pick<WebChatRepository, "ensureChannelChat" | "addConversationMessage">;
  hasAgent(name: string): boolean;
}

/**
 * The message text followed by one line per attachment saved to disk, which
 * is how a channel message reads in a chat's transcript and in a turn's
 * prompt. An attachment without a `localPath` is left out.
 */
export function appendAttachmentPathsToPrompt(text: string, attachments: unknown): string {
  const saved = Array.isArray(attachments)
    ? attachments.filter(
        (attachment): attachment is Attachment =>
          typeof attachment === "object" &&
          attachment !== null &&
          "type" in attachment &&
          typeof attachment.localPath === "string" &&
          attachment.localPath.trim().length > 0,
      )
    : [];
  if (saved.length === 0) return text.trim();
  const lines = saved.map((attachment, index) => {
    const name = attachment.fileName ? ` ${attachment.fileName}` : "";
    const caption = attachment.caption ? ` caption: ${attachment.caption}` : "";
    return `Attachment ${index + 1} (${attachment.type}${name}) path: ${attachment.localPath}${caption}`;
  });
  return [text.trim(), lines.join("\n")].filter(Boolean).join("\n\n").trim();
}

/** One line per attachment that was not saved to disk, so a declined message
 *  that was only a file still tells the next turn what was sent. */
function appendUnsavedAttachments(content: string, attachments: readonly Attachment[]): string {
  const unsaved = attachments.filter((attachment) => !attachment.localPath?.trim());
  if (unsaved.length === 0) return content;
  const lines = unsaved.map((attachment) => {
    const name = attachment.fileName ? ` ${attachment.fileName}` : "";
    const caption = attachment.caption ? ` caption: ${attachment.caption}` : "";
    return `Attachment (${attachment.type}${name}) not downloaded${caption}`;
  });
  return [content, lines.join("\n")].filter(Boolean).join("\n\n");
}

/** The agent a chat recorded for the first time stores: the chat's own choice
 *  while it is loaded, and main otherwise. */
function initialAgent(routedAgentName: string | undefined, hasAgent: (name: string) => boolean) {
  const requested = routedAgentName?.trim();
  if (!requested || isCoreMainAgentId(requested)) return "main";
  return hasAgent(requested) ? requested : "main";
}

export function createChatMessageRecorder(deps: ChatMessageRecorderDeps): RecordChatMessageHandler {
  return async ({ service, message, routedAgentName }) => {
    if (!message.messageId) {
      throw new Error("Inbound channel message is missing its platform message id");
    }
    const threadType = message.thread?.kind === "dm" ? "private" : "group";
    const person = (await deps.findPerson(service, message.senderId)) ?? null;
    const bondLevel = person?.bondLevel ?? "other";
    const policy = await deps.evaluatePolicy({
      channel: service,
      sender: person ? { id: person.id, bondLevel: person.bondLevel } : null,
      bondLevel,
      threadName: message.thread?.name,
      threadType,
    });
    if (policy.action === "block") {
      log.info("message blocked by policy", { channel: service, channelUserId: message.senderId });
      return { status: "blocked" };
    }

    const chat = await deps.chats.ensureChannelChat({
      channel: service,
      threadId: message.chatId,
      parentThreadId: message.parentChatId || undefined,
      threadName: message.thread?.name,
      threadType,
      agentName: initialAgent(routedAgentName, deps.hasAgent),
    });
    const createdAt = Number.isNaN(message.timestamp.getTime()) ? undefined : message.timestamp;
    const content = appendUnsavedAttachments(
      appendAttachmentPathsToPrompt(message.text ?? "", message.attachments),
      message.attachments,
    );
    const stored = await deps.chats.addConversationMessage({
      sessionId: chat.id,
      role: "notification",
      content: JSON.stringify([{ type: "text", content }]),
      platformMessageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderDisplayName ?? message.senderId,
      replyToPlatformMessageId: message.replyTo?.messageId?.trim() || undefined,
      createdAt,
    });
    if (!stored.inserted) return { status: "duplicate" };
    log.debug("message recorded without an answer by the reply rule", {
      channel: service,
      channelUserId: message.senderId,
    });
    return { status: "recorded" };
  };
}
