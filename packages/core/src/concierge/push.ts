// A Concierge turn the guardian did not start sends the first message it says
// to the guardian's phone (docs/adrs/proactive-concierge-push-without-per-message-consent.md).

import { marked, type Token } from "marked";
import type { NotifyLevel, SendOutcome, SystemNotifyContent } from "../lib/notify-client.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-push");

/** About this many characters of the message reach the phone. */
export const PUSH_BODY_MAX_CHARS = 100;
/** Turns remembered as pushed. A session runs one turn at a time, so a few suffice. */
const PUSHED_TURNS_KEPT = 64;

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
  now?: () => number;
}

/** What the Concierge said, and where. */
export interface SaidInTurn {
  turnId: string;
  chatId: string;
  /**
   * The message in the Concierge's own words: what it wrote itself, never
   * content it forwarded or quoted, which may hold a secret it would not repeat.
   */
  ownWords: string;
  /** The turn's push level; undefined for a turn the guardian started. */
  level: NotifyLevel | undefined;
}

export class ConciergePush {
  private readonly pushed = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: ConciergePushDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Pushes the first message of a turn that has a push level. Answers at once:
   * the push never holds or fails the turn, and the message stays in the chat
   * whatever happens to it.
   */
  said(said: SaidInTurn): void {
    const { turnId, chatId, level } = said;
    if (!level || this.pushed.has(turnId)) return;
    this.pushed.add(turnId);
    if (this.pushed.size > PUSHED_TURNS_KEPT) {
      this.pushed.delete(this.pushed.values().next().value as string);
    }
    void this.send(said, level).catch((error: unknown) =>
      log.warn("concierge push failed", {
        turnId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private async send({ turnId, chatId, ownWords }: SaidInTurn, level: NotifyLevel): Promise<void> {
    if ((await this.deps.quietUntil(this.now())) !== null) {
      log.info("concierge push held back by quiet hours", { turnId, chatId });
      return;
    }
    const outcome = await this.deps.notify.send({ body: pushBody(ownWords), level, chatId });
    // The outcome only: the body never reaches a log.
    log.info("concierge push", { turnId, chatId, level, outcome: outcome.kind });
  }
}
