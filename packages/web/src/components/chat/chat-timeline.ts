import { userMessageText } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/chat-types";

// The pure model behind the question timeline rail. It never touches the DOM,
// so the compact sequence and overflow rules stay testable without layout.

/** Below this many questions the rail is not worth its pixels. */
export const MIN_TIMELINE_QUESTIONS = 4;

/** Preferred distance between adjacent question markers, in px. */
export const TIMELINE_NODE_STEP_PX = 8;

const SUMMARY_MAX_CHARS = 60;

/** Sub-pixel drift that must not trigger a re-render. */
const POSITION_EPSILON_PX = 0.5;

export interface TimelineQuestion {
  messageId: string;
  /** The question's plain text, exactly as the bubble renders it. */
  text: string;
}

export interface TimelineNode {
  messageId: string;
  topPx: number;
}

/**
 * Every question the rail can point at: user turns that actually render a
 * bubble, in transcript order.
 *
 * Deliberately not filtered to the main session. While a handoff is open the
 * composer posts to the child session, so a filter would drop every question
 * asked during that handoff — a whole stretch of the conversation missing from
 * the rail with nothing to explain the gap. Those rows are spliced into
 * `displayMessages` and carry their own anchors, so they are addressable like
 * any other. Share selection does filter by session, but that decides which
 * turns can be frozen into a link, not what can be scrolled to.
 *
 * Text-less user turns are excluded because `UserMessage` returns null for
 * them, so there would be no anchor. The suppressed handoff seed is already
 * absent from `displayMessages`.
 */
export function buildTimelineQuestions(messages: ChatMessage[]): TimelineQuestion[] {
  const questions: TimelineQuestion[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = userMessageText(message.content).trim();
    if (!text) continue;
    questions.push({ messageId: message.id, text });
  }
  return questions;
}

/**
 * A one-line label. You need enough to recognise a question you wrote, not to
 * re-read it — 60 chars keeps the tooltip to one line at typical lengths, and
 * keeps the Chinese build from rendering an essay in a 320px box.
 */
export function summarizeQuestion(text: string, maxChars = SUMMARY_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** The rail is for chats you cannot scan by scrolling. */
export function shouldShowTimeline(
  questionCount: number,
  metrics: { scrollHeight: number; clientHeight: number },
): boolean {
  if (questionCount < MIN_TIMELINE_QUESTIONS) return false;
  if (metrics.clientHeight <= 0) return false;
  return metrics.scrollHeight >= metrics.clientHeight * 2;
}

/**
 * Lay questions out in transcript order at a stable, compact rhythm.
 *
 * Rendered message height is deliberately absent from this contract. A marker
 * represents one question, so wrapping, code blocks, media, and streamed reply
 * growth must not change the navigation structure. When the preferred rhythm
 * cannot fit, the step tightens evenly so every question remains represented.
 */
export function layoutTimelineNodes(
  messageIds: string[],
  opts: { trackHeight: number; stepPx: number },
): TimelineNode[] {
  const { trackHeight, stepPx } = opts;
  if (messageIds.length === 0 || trackHeight <= 0) return [];

  const step = messageIds.length > 1 ? Math.min(stepPx, trackHeight / (messageIds.length - 1)) : 0;
  const span = step * (messageIds.length - 1);
  const start = (trackHeight - span) / 2;

  return messageIds.map((messageId, index) => ({
    messageId,
    topPx: start + index * step,
  }));
}

/**
 * Whether a fresh layout is worth committing. ResizeObserver can report
 * sub-pixel track changes, which should not re-render every tooltip root.
 */
export function sameNodes(a: TimelineNode[], b: TimelineNode[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (node, i) =>
      node.messageId === b[i].messageId && Math.abs(node.topPx - b[i].topPx) < POSITION_EPSILON_PX,
  );
}
