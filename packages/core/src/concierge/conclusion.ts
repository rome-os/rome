import type { ThreadContext } from "@rome-os/app-runtime";
import type { WebChatRepository } from "../webchat/repository.js";
import { TASK_CHAT_TRIGGER_KIND } from "../webchat/privacy.js";

// A task chat's conclusion: the short closing section of each final answer,
// which the Concierge passes on instead of the whole answer. The marker is an
// HTML comment pair, so the dashboard's Markdown hides it and the section
// reads as a paragraph of its own (docs/architecture/concierge.md).

/** The longest conclusion the Concierge forwards, in characters. */
export const CONCLUSION_MAX_CHARS = 600;

export const CONCLUSION_OPEN = "<!-- rome:conclusion -->";
export const CONCLUSION_CLOSE = "<!-- /rome:conclusion -->";

// Spaces inside the comment are forgiven, and the closing marker is optional:
// a section the task forgot to close runs to the end of its answer.
const OPEN = /<!--\s*rome:conclusion\s*-->/g;
const CLOSE = /<!--\s*\/rome:conclusion\s*-->/;
const ANY_MARKER = /<!--\s*\/?rome:conclusion\s*-->/g;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const lengthOf = (text: string) => Array.from(graphemes.segment(text)).length;

export type Conclusion =
  | { kind: "found"; text: string }
  | { kind: "missing" }
  | { kind: "too_long"; length: number };

/**
 * The conclusion of a task chat's answer: what lies between the last opening
 * marker and its closing marker, trimmed. A missing or empty section is
 * `missing`, and one over {@link CONCLUSION_MAX_CHARS} is `too_long`, which is
 * never cut: the Concierge reports in its own words instead.
 */
export function conclusionOf(answer: string): Conclusion {
  const opens = [...answer.matchAll(OPEN)];
  const open = opens.at(-1);
  if (!open) return { kind: "missing" };
  const rest = answer.slice(open.index + open[0].length);
  const close = CLOSE.exec(rest);
  const text = (close ? rest.slice(0, close.index) : rest).trim();
  if (!text) return { kind: "missing" };
  const length = lengthOf(text);
  return length > CONCLUSION_MAX_CHARS ? { kind: "too_long", length } : { kind: "found", text };
}

/**
 * The answer with the conclusion's markers removed and everything else
 * untouched: a line the markers leave empty goes with them, and no other
 * whitespace changes, so a code block's blank lines and a full forward stay as
 * written.
 */
export function withoutMarkers(answer: string): string {
  return answer
    .split("\n")
    .flatMap((line) => {
      const stripped = line.replace(ANY_MARKER, "");
      return stripped === line || stripped.trim() !== "" ? [stripped] : [];
    })
    .join("\n");
}

/** The answer without its conclusion section, markers included. */
export function withoutConclusion(answer: string): string {
  const open = [...answer.matchAll(OPEN)].at(-1);
  if (!open) return answer.trim();
  const rest = answer.slice(open.index + open[0].length);
  const close = CLOSE.exec(rest);
  const after = close ? rest.slice(close.index + close[0].length) : "";
  // An excerpt for the Concierge to read, so the gap the section leaves closes.
  return `${answer.slice(0, open.index)}${after}`.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * What every task chat is told, whoever writes to it. It rides the chat's
 * system prompt, so a follow-up, a continuation and the guardian's own
 * message get it too. The conclusion follows the language of the guardian's
 * request as the Concierge's brief gives it.
 */
export const CONCLUSION_INSTRUCTION = [
  "## Your conclusion",
  "",
  "The guardian's Concierge started this chat for a task. Every final answer you give here keeps its full content. End it with a separate conclusion section, written in the language of the guardian's request as your brief gives it, on lines of their own between these two markers, exactly:",
  "",
  CONCLUSION_OPEN,
  "the conclusion",
  CONCLUSION_CLOSE,
  "",
  `The conclusion is the outcome in one or two sentences, at most ${CONCLUSION_MAX_CHARS} characters, plus anything the guardian must decide or do, such as a question you need answered. The Concierge passes this section on to the guardian word for word and nothing else of your answer, so it must make sense alone. Never put a secret, code, password or token in it. Write it in every final answer, after a follow-up and when the guardian writes to you directly too.`,
  "",
  "Your answer here is how your result reaches the guardian: the Concierge forwards it. Never send a message into the guardian's Concierge chat yourself, with `system:send_message` or any other tool, and never set up a routine that does. Recurring work is the Concierge's scheduled task, not a routine of yours.",
].join("\n");

/**
 * The agent context's `chatInstructions` for Rome: the conclusion instruction
 * for a task chat, whichever way its session opens, and nothing for any other
 * chat.
 */
export function taskChatInstructions(deps: {
  webchatRepo: Pick<WebChatRepository, "getSession">;
}): (thread: Pick<ThreadContext, "channel" | "threadId"> | undefined) => Promise<string | null> {
  return async (thread) => {
    if (thread?.channel !== "webchat" || !thread.threadId) return null;
    const chat = await deps.webchatRepo.getSession(thread.threadId);
    return chat?.triggerKind === TASK_CHAT_TRIGGER_KIND ? CONCLUSION_INSTRUCTION : null;
  };
}
