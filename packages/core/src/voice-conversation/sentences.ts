// Cuts streamed text into sentences, so each one can be spoken as soon as it
// is complete. Chinese and English punctuation and line ends close a
// sentence. A long run without any is cut at a comma.

// Closes a sentence wherever it stands.
const CJK_END = /[。！？；…\n]/u;
// Closes a sentence only before a space or the end: `3.5` and `v1.2` stay whole.
const LATIN_END = /[.!?;]/u;
const CLAUSE_END = /[，、,：:]/u;
// Past this many characters a sentence is cut at its last comma.
const LONG_SENTENCE = 80;
// A comma before this many characters makes too short a first part.
const SHORTEST_PART = 20;

export interface SentenceSplitter {
  /** Adds text and returns the sentences it completes, in order. */
  push(text: string): string[];
  /** Returns the rest as the last sentence, if any. */
  end(): string[];
}

export function createSentenceSplitter(): SentenceSplitter {
  let buffer = "";

  const cut = (final: boolean): string[] => {
    const sentences: string[] = [];
    let start = 0;
    const chars = Array.from(buffer);
    let clause = -1;
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i] as string;
      const next = chars[i + 1];
      const ends =
        CJK_END.test(char) ||
        (LATIN_END.test(char) && (next === undefined ? final : /\s/u.test(next)));
      if (ends) {
        sentences.push(chars.slice(start, i + 1).join(""));
        start = i + 1;
        clause = -1;
        continue;
      }
      if (CLAUSE_END.test(char) && i + 1 - start >= SHORTEST_PART) clause = i + 1;
      if (i + 1 - start > LONG_SENTENCE && clause > start) {
        sentences.push(chars.slice(start, clause).join(""));
        start = clause;
        clause = -1;
      }
    }
    buffer = chars.slice(start).join("");
    if (final && buffer) {
      sentences.push(buffer);
      buffer = "";
    }
    return sentences.map((s) => s.trim()).filter(Boolean);
  };

  return {
    push(text) {
      buffer += text;
      return cut(false);
    },
    end() {
      return cut(true);
    },
  };
}
