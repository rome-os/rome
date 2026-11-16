// The quote a reply stores. docs/domains/chats.md#chat-thread

import { REPLY_TO_TEXT_MAX_LENGTH, type ReplyToPart } from "@rome/api-types/chat";
import { automatedSource } from "./automated-source.js";

/** One span of a stored message's readable text; `commentary` marks an agent's working notes. */
export interface TextSpan {
  text: string;
  commentary: boolean;
}

/** The readable text of a stored message: text parts, and a task chat card as one line. */
export function textSpans(content: string): TextSpan[] {
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part): TextSpan[] => {
    if (!part || typeof part !== "object") return [];
    const { type, content: text, title, chatId, turnPhase } = part as Record<string, unknown>;
    if (type === "text" && typeof text === "string" && text.trim()) {
      return [{ text, commentary: turnPhase === "commentary" }];
    }
    if (type === "task_chat" && typeof title === "string" && typeof chatId === "string") {
      return [{ text: `[Task chat] ${title} (chat ${chatId})`, commentary: false }];
    }
    return [];
  });
}

/** `text` cut to {@link REPLY_TO_TEXT_MAX_LENGTH} characters, ending in an ellipsis when cut. */
export function truncateQuote(text: string): string {
  if (text.length <= REPLY_TO_TEXT_MAX_LENGTH) return text;
  let cut = text.slice(0, REPLY_TO_TEXT_MAX_LENGTH - 1);
  // A cut between the halves of a surrogate pair would store a broken character.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * The quote of the whole of one message, which is the part an agent's reply
 * to it stores. Null when the message has no text to quote. An automation's
 * message carries no name here: the client shows its generic one.
 */
export function replyQuoteOf(message: {
  id: string;
  role: "user" | "assistant";
  content: string;
  senderId?: string | null;
}): ReplyToPart | null {
  const text = textSpans(message.content)
    .map((span) => span.text)
    .join("\n\n");
  if (!text.trim()) return null;
  const author =
    message.role === "assistant"
      ? "agent"
      : automatedSource(message.senderId)
        ? "automated"
        : "guardian";
  return { type: "reply_to", messageId: message.id, author, text: truncateQuote(text) };
}
