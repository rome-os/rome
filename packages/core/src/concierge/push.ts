// A Concierge turn with a push level, proactive or the reply to the guardian's
// own message, sends one push to the guardian's phone, on the first message it
// says while the phone app does not show the chat and no guardian dashboard is
// active. Its words come only from
// the turn's first message: a push on a later one says a fixed line
// (docs/adrs/proactive-concierge-push-without-per-message-consent.md).

import { marked, type Token } from "marked";
import type { NotifyLevel, SendOutcome, SystemNotifyContent } from "../lib/notify-client.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-push");

/** About this many characters of the message reach the phone. */
export const PUSH_BODY_MAX_CHARS = 100;
/** Turns remembered as pushed or spoken in. A session runs one turn at a time, so a few suffice. */
const TURNS_KEPT = 64;

// The lexer escapes these in text, as HTML would show them.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Block tokens end with a space, so two paragraphs never run together.
const BLOCKS = new Set(["paragraph", "heading", "code", "blockquote", "list_item", "table"]);

function plainOf(tokens: Token[]): string {
  return tokens
    .map((token) => {
      const text = (() => {
        switch (token.type) {
          case "list":
            return plainOf(token.items as Token[]);
          case "table":
            return [token.header, ...token.rows]
              .flat()
              .map((cell: { tokens: Token[] }) => plainOf(cell.tokens))
              .join(" ");
          case "image":
            return token.text;
          case "html":
          case "space":
          case "hr":
          case "br":
            return " ";
          case "code":
          case "codespan":
            return token.text;
        }
        if ("tokens" in token && token.tokens?.length) return plainOf(token.tokens);
        return "text" in token && typeof token.text === "string" ? token.text : "";
      })();
      return BLOCKS.has(token.type) ? `${text} ` : text;
    })
    .join("");
}

/**
 * The message as a push shows it: Markdown reduced to its words on one line,
 * cut to about {@link PUSH_BODY_MAX_CHARS} characters, never inside an emoji.
 */
export function pushBody(markdown: string): string {
  const text = plainOf(marked.lexer(markdown))
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(graphemes.segment(text), (part) => part.segment);
  if (chars.length <= PUSH_BODY_MAX_CHARS) return text;
  return `${chars
    .slice(0, PUSH_BODY_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

export interface ConciergePushDeps {
  notify: { send(content: SystemNotifyContent): Promise<SendOutcome> };
  /** When the quiet window `at` falls in ends, or null outside quiet hours. */
  quietUntil: (at: number) => Promise<number | null>;
  /** Whether a message in this chat may reach the guardian's phone: only one of their own chats. */
  pushesFor: (chatId: string) => Promise<boolean>;
  /** Whether the guardian's phone app shows this chat now: then it is read there, not pushed. */
  watching?: (chatId: string) => boolean;
  /** Whether the guardian is at one of their web dashboards now: then nothing pushes, in any chat. */
  dashboardActive?: () => boolean;
  /** The guardian's dashboard language, as its setting holds it, or null. */
  language: () => Promise<string | null>;
  now?: () => number;
}

/** What the Concierge said, and where. */
export interface SaidInTurn {
  turnId: string;
  chatId: string;
  /**
   * The message in the Concierge's own words: what it wrote in this message,
   * never content it forwarded or quoted, nor a task's title or chat name,
   * which may hold a secret it would not repeat. Null when it wrote none, as
   * for a bare forward or a card: the push then says {@link FIXED_LINE}.
   */
  ownWords: string | null;
  /** The turn's push level; undefined for a reminder, a recovery or a notice. */
  level: NotifyLevel | undefined;
}

/** The line a push says for a message with none of the Concierge's own words, by dashboard language. */
export const FIXED_LINE: Record<string, string> = {
  en: "A task has an update",
  "zh-CN": "有个任务有了新进展",
};

export class ConciergePush {
  private readonly pushed = new Set<string>();
  /** Turns that have said a message: any later one is not the first. */
  private readonly spoken = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: ConciergePushDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Pushes the first message of a turn that has a push level, skipping any the
   * phone shows or said while a guardian dashboard is active. A skipped
   * message is dropped, never pushed later. Answers at once: the push never holds or fails
   * the turn, and the message stays in the chat whatever happens to it.
   */
  said(said: SaidInTurn): void {
    const { turnId, chatId, level } = said;
    if (!level || this.pushed.has(turnId)) return;
    const first = remember(this.spoken, turnId);
    // A message read on the phone or at the dashboard leaves the turn's push
    // to a later message, so an answer that comes after the guardian leaves
    // still pushes.
    if (this.deps.watching?.(chatId)) {
      log.info("concierge push skipped: the phone shows the chat", { turnId, chatId });
      return;
    }
    if (this.deps.dashboardActive?.()) {
      log.info("concierge push held back: a dashboard is active", { turnId, chatId });
      return;
    }
    remember(this.pushed, turnId);
    // Only the first message is held to keeping secrets off the lock screen;
    // the Concierge gives them in a later one, so a later push never shows it.
    const preview = first ? said : { ...said, ownWords: null };
    void this.send(preview, level).catch((error: unknown) =>
      log.warn("concierge push failed", {
        turnId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private async send({ turnId, chatId, ownWords }: SaidInTurn, level: NotifyLevel): Promise<void> {
    if (!(await this.deps.pushesFor(chatId))) return;
    if ((await this.deps.quietUntil(this.now())) !== null) {
      log.info("concierge push held back by quiet hours", { turnId, chatId });
      return;
    }
    const body = ownWords ?? (await this.fixedLine());
    const outcome = await this.deps.notify.send({ body: pushBody(body), level, chatId });
    // The outcome only: the body never reaches a log.
    log.info("concierge push", { turnId, chatId, level, outcome: outcome.kind });
  }

  private async fixedLine(): Promise<string> {
    const language = await this.deps.language().catch(() => null);
    return language && Object.hasOwn(FIXED_LINE, language) ? FIXED_LINE[language] : FIXED_LINE.en;
  }
}

/** Adds a turn, forgetting the oldest past the cap; true when it was new. */
function remember(turns: Set<string>, turnId: string): boolean {
  if (turns.has(turnId)) return false;
  turns.add(turnId);
  if (turns.size > TURNS_KEPT) turns.delete(turns.values().next().value as string);
  return true;
}
