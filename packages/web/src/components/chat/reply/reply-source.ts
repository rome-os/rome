import { REPLY_TO_TEXT_MAX_LENGTH } from "@rome/api-types/chat";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { ChatMessage } from "@/lib/chat-types";

/** What a Reply button quotes: one message, or the answer of one agent turn. */
export interface ReplySource {
  /** The message the server looks up. For an agent turn, its last row with text. */
  messageId: string;
  sessionId: string;
  author: "guardian" | "agent";
  name?: string;
  /** The text a whole-message reply quotes. */
  text: string;
}

/**
 * Quoted markdown as plain reading text for a chip or a quote block: heading,
 * list, and quote markers, emphasis, and code ticks are dropped and lines
 * run together. The stored quote keeps the source text.
 */
export function plainQuote(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s?)/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/**
 * Whether the server has recorded a guardian message and the agent has taken
 * it in. A message still sending, queued, or undelivered offers no Reply.
 */
export function isSettledUserMessage(message: ChatMessage): boolean {
  return !message.inputState || message.inputState === "consumed";
}

/** `text` cut to what core stores: at most {@link REPLY_TO_TEXT_MAX_LENGTH} characters, ending in an ellipsis when cut. */
export function replyPreview(text: string): string {
  return text.length <= REPLY_TO_TEXT_MAX_LENGTH
    ? text
    : `${text.slice(0, REPLY_TO_TEXT_MAX_LENGTH - 1)}…`;
}

/**
 * The element that anchors `messageId` in `root`: a user bubble names its own
 * id, an agent turn lists every id it holds, separated by spaces.
 */
export function findMessageAnchor(root: ParentNode, messageId: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("[data-timeline-anchor]")) {
    if (element.dataset.timelineAnchor?.split(" ").includes(messageId)) return element;
  }
  return null;
}

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The text the window selection covers when it lies wholly inside `scope`,
 * and is found in `source` once whitespace is collapsed. A selection across
 * rendered markdown (bold, list markers, links) reads differently from its
 * source, so core would refuse it; that case, a collapsed selection, and one
 * crossing out of `scope` all return undefined.
 */
export function selectedQuote(scope: Element | null, source: string): string | undefined {
  const selection = window.getSelection();
  if (!scope || !selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  if (!scope.contains(selection.getRangeAt(0).commonAncestorContainer)) return undefined;
  const text = selection.toString().trim();
  return text && collapse(source).includes(collapse(text)) ? text : undefined;
}

/**
 * The answer an agent turn quotes: the text of its messages without
 * commentary, or all their text when nothing else remains. Core builds the
 * same text for the stored quote.
 */
export function turnAnswerText(messages: ChatMessage[]): string {
  const spans = messages.flatMap((message) =>
    parseMessageEntries(message).flatMap((part) =>
      part.type === "text" && part.content.trim()
        ? [{ text: part.content, commentary: part.turnPhase === "commentary" }]
        : [],
    ),
  );
  const answer = spans.filter((span) => !span.commentary);
  return (answer.length > 0 ? answer : spans).map((span) => span.text).join("\n\n");
}

/** The last of `messages` that has text, which stands for the whole turn when replying to it. */
export function lastTextMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.findLast((message) =>
    parseMessageEntries(message).some((part) => part.type === "text" && part.content.trim()),
  );
}
