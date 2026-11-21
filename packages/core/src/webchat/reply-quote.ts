// The quote a reply stores. docs/domains/chats.md#chat-thread

import {
  REPLY_TO_TEXT_MAX_LENGTH,
  type ReplyToPart,
  type TaskChatWaitedOn,
} from "@rome/api-types/chat";
import { automatedSource } from "./automated-source.js";

/** One span of a stored message's readable text; `commentary` marks an agent's working notes. */
export interface TextSpan {
  text: string;
  commentary: boolean;
}

/** The parts of a stored message, or none when its content is not a list of them. */
function partsOf(content: string): Record<string, unknown>[] {
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return [];
  }
  return Array.isArray(parts)
    ? parts.filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
    : [];
}

/**
 * The readable text of a stored message for an agent: text parts, and a task
 * chat card as one line that names its chat. What the guardian is shown is
 * {@link quoteSpans}.
 */
export function textSpans(content: string): TextSpan[] {
  return partsOf(content).flatMap((part): TextSpan[] => {
    const { type, content: text, title, chatId, turnPhase } = part;
    if (type === "text" && typeof text === "string" && text.trim()) {
      return [{ text, commentary: turnPhase === "commentary" }];
    }
    if (type === "task_chat" && typeof title === "string" && typeof chatId === "string") {
      return [{ text: `[Task chat] ${title} (chat ${chatId})`, commentary: false }];
    }
    return [];
  });
}

/** Reads what the question or approval a task card shows says, or null. */
export type CardLine = (chatId: string, waitedOn: TaskChatWaitedOn) => Promise<string | null>;

/**
 * The readable text of a stored message for the guardian, which is what a
 * quote shows: text parts, and a task chat card as its own words, never an
 * id. A task card reads as its task's title; an `ask` card as its question or
 * approval, read by `cardLine`, else as the title.
 */
export async function quoteSpans(content: string, cardLine?: CardLine): Promise<TextSpan[]> {
  const spans: TextSpan[] = [];
  for (const part of partsOf(content)) {
    const { type, content: text, title, chatId, turnPhase, show, waitedOn } = part;
    if (type === "text" && typeof text === "string" && text.trim()) {
      spans.push({ text, commentary: turnPhase === "commentary" });
    } else if (type === "task_chat" && typeof title === "string" && typeof chatId === "string") {
      const asked =
        show === "ask" && waitedOn && cardLine
          ? await cardLine(chatId, waitedOn as TaskChatWaitedOn)
          : null;
      const line = asked?.trim() || title.trim();
      if (line) spans.push({ text: line, commentary: false });
    }
  }
  return spans;
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
 * to it stores. A card quotes as its own words (see {@link quoteSpans}). Null
 * when the message has none. An automation's message carries no name here: the
 * client shows its generic one.
 */
export async function replyQuoteOf(
  message: {
    id: string;
    role: "user" | "assistant";
    content: string;
    senderId?: string | null;
  },
  cardLine?: CardLine,
): Promise<ReplyToPart | null> {
  const text = (await quoteSpans(message.content, cardLine)).map((span) => span.text).join("\n\n");
  if (!text.trim()) return null;
  const author =
    message.role === "assistant"
      ? "agent"
      : automatedSource(message.senderId)
        ? "automated"
        : "guardian";
  return { type: "reply_to", messageId: message.id, author, text: truncateQuote(text) };
}
