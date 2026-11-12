import type { ThreadContext } from "@rome-os/app-runtime";
import type { SettingsRepository } from "../db/repositories/settings.js";
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

/** The name of a language code, in English, or null when it is not a language. */
function languageName(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? null;
  } catch {
    return null;
  }
}

/**
 * What every task chat is told, whoever writes to it. It rides the chat's
 * system prompt, so a follow-up, a continuation and the guardian's own
 * message get it too. `language` is the guardian's dashboard language code, or
 * null when it is unknown: the conclusion then follows the language of the
 * guardian's own request in the brief.
 */
export function conclusionInstruction(language: string | null): string {
  const name = languageName(language);
  const written = name
    ? `in the guardian's language, ${name}`
    : "in the language of the guardian's own request in your brief";
  return [
    "## Your conclusion",
    "",
    `The guardian's Concierge started this chat for a task. Every final answer you give here keeps its full content. End it with a separate conclusion section, written ${written}, on lines of their own between these two markers, exactly:`,
    "",
    CONCLUSION_OPEN,
    "the conclusion",
    CONCLUSION_CLOSE,
    "",
    `The conclusion is the outcome in one or two sentences, at most ${CONCLUSION_MAX_CHARS} characters, plus anything the guardian must decide or do, such as a question you need answered. The Concierge passes this section on to the guardian word for word and nothing else of your answer, so it must make sense alone. Never put a secret, code, password or token in it. Write it in every final answer, after a follow-up and when the guardian writes to you directly too.`,
  ].join("\n");
}

/**
 * The agent context's `chatInstructions` for Rome: the conclusion instruction
 * for a task chat, whichever way its session opens, and nothing for any other
 * chat. The guardian's language is the dashboard language they picked.
 */
export function taskChatInstructions(deps: {
  webchatRepo: Pick<WebChatRepository, "getSession">;
  settingsRepo: Pick<SettingsRepository, "get">;
}): (thread: Pick<ThreadContext, "channel" | "threadId"> | undefined) => Promise<string | null> {
  return async (thread) => {
    if (thread?.channel !== "webchat" || !thread.threadId) return null;
    const chat = await deps.webchatRepo.getSession(thread.threadId);
    if (chat?.triggerKind !== TASK_CHAT_TRIGGER_KIND) return null;
    const stored = await deps.settingsRepo.get("guardianLanguage");
    return conclusionInstruction(typeof stored === "string" ? stored : null);
  };
}
