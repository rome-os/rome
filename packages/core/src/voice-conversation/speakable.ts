// Turns an agent's Markdown reply, as it streams in, into text worth saying.
// Code blocks and tables are not read out: the first one in a reply becomes
// one sentence that points to the chat, and the rest are dropped. Headings,
// quotes and list markers lose their marks. Links keep their words.

/** What a reply says instead of its first code block or table. */
const POINTER_SENTENCE = { zh: "详细内容在聊天里。", en: "The details are in the chat." };

export type ReplyLanguage = keyof typeof POINTER_SENTENCE;

// A line's first characters are enough to tell prose from a fence or a table.
const DECIDED_AT = 4;
const FENCE = /^(```|~~~)/;
const LINE_MARK = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/;

export interface SpeakableFilter {
  /** Adds streamed Markdown and returns the speakable text it completes. */
  push(markdown: string): string;
  /** Returns what is left at the end of the reply. */
  end(): string;
  /** Points to the chat for something not said, such as a card: once a reply, as for code. */
  point(): string;
}

export function createSpeakableFilter(language: ReplyLanguage): SpeakableFilter {
  let inFence = false;
  let pointed = false;
  // The start of the current line, while it is too short to tell what it is.
  let undecided = "";
  // What the current line is, once known.
  let kind: "prose" | "skip" | null = null;

  const point = () => {
    if (pointed) return "";
    pointed = true;
    return `${POINTER_SENTENCE[language]}\n`;
  };

  // Decides what the line starting with `head` is, and returns what of it to say.
  const decide = (head: string): string => {
    const start = head.trimStart();
    if (FENCE.test(start)) {
      inFence = !inFence;
      kind = "skip";
      return inFence ? point() : "";
    }
    if (inFence) {
      kind = "skip";
      return "";
    }
    if (start.startsWith("|")) {
      kind = "skip";
      return point();
    }
    kind = "prose";
    return start.replace(LINE_MARK, "");
  };

  const take = (piece: string, complete: boolean): string => {
    let out = "";
    if (kind === null) {
      undecided += piece;
      const start = undecided.trimStart();
      if (!complete && start.length < DECIDED_AT) return "";
      out = start ? decide(undecided) : "";
      undecided = "";
    } else if (kind === "prose") {
      out = piece;
    }
    if (complete) {
      if (kind === "prose") out += "\n";
      kind = null;
    }
    return out;
  };

  return {
    push(markdown) {
      let out = "";
      const lines = markdown.split("\n");
      lines.forEach((piece, i) => {
        out += take(piece, i < lines.length - 1);
      });
      return out;
    },
    end() {
      return take("", true);
    },
    point,
  };
}

/** One sentence as it should be said: no inline Markdown, no addresses. Empty when nothing is left to say. */
export function plainSentence(sentence: string): string {
  const plain = sentence
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Not a sanitizer, only what is said. A tag becomes a space, so the pieces
    // around it never join, and with no angle bracket left no tag can remain.
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/[<>]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|~~|\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(plain) ? plain : "";
}
