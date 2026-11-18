// Filler sounds, such as 嗯, 呃, um and uh, are transcribed word for word.
// They are dropped before the text reaches the message field. Only a filler
// that stands alone goes: 好啊 and 额度 stay, and so do umbrella and UM.
// A filler that asks, as in 嗯？, stays, and so does a dictation that is
// nothing but fillers, such as a lone 嗯 that means yes.

// 嗯 and 呃 go wherever they are, except in 嗯哼, which means uh-huh.
// 啊 and 唔 are part of words, as in 好啊, so they go only between
// punctuation or spaces. An English filler is lower case or capitalized:
// UM and UH are acronyms.
const FILLER =
  /[嗯呃]+(?![嗯呃哼])|[啊唔]+|(?<![\p{Script=Latin}\p{N}'’-])(?:[Uu](?:m+|h+|hm)|[Ee]rm+|[Hh]m+)(?![\p{Script=Latin}\p{N}'’-])/gu;
const NEEDS_SEPARATORS = /^[啊唔]+$/u;
const ENGLISH = /^[A-Za-z]/;
// A word an English filler would be the end of, as in premi|um.
const IN_WORD = /[\p{Script=Latin}\p{N}'’-]/u;
const QUESTION = /^\s*[?？]/u;
const SEPARATOR = /[\s\p{P}]/u;
// A pause inside a sentence, which goes with the filler before it.
const PAUSE = /^\s*(?:[,，、;；:：]|\.\.\.|…+|--|—+)\s*/u;
const SENTENCE_END = /^\s*[.!?。！？]+/u;
const TRAILING_PAUSE = /\s*(?:[,，、;；:：]|\.\.\.|…+|--|—+)\s*$/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * `text` without its standalone fillers and the pause after each. `before`
 * is the cleaned text already shown ahead of it, which is read for context
 * and never changed.
 */
export function removeFillerWords(text: string, before = ""): string {
  // Only the end of the text before is read.
  before = before.slice(-16);
  let out = "";
  let at = 0;
  // Set when a sentence began with a dropped filler: the first word kept
  // after it, past any more fillers, takes the capital.
  let capitalize = false;
  const keep = (kept: string) => {
    if (capitalize && /\S/u.test(kept)) {
      capitalize = false;
      kept = kept.replace(
        /^(\s*)([a-z])/,
        (_, space: string, letter: string) => space + letter.toUpperCase(),
      );
    }
    out += kept;
  };
  for (const match of text.matchAll(FILLER)) {
    const start = match.index;
    if (start < at) continue;
    const filler = match[0];
    let end = start + filler.length;
    const prev = (before + out + text.slice(at, start)).slice(-1);
    const next = text.charAt(end);
    if (
      NEEDS_SEPARATORS.test(filler) &&
      ((prev !== "" && !SEPARATOR.test(prev)) || (next !== "" && !SEPARATOR.test(next)))
    )
      continue;
    // The text can start inside a word that began in the text before it.
    if (ENGLISH.test(filler) && IN_WORD.test(prev)) continue;
    if (QUESTION.test(text.slice(end))) continue;
    keep(text.slice(at, start));
    const shown = before + out;
    const pause = PAUSE.exec(text.slice(end));
    const stop = SENTENCE_END.exec(text.slice(end));
    if (pause) {
      end += pause[0].length;
    } else if (stop) {
      const kept = shown.trimEnd();
      if (kept === "" || /[.!?。！？]$/u.test(kept)) {
        // A filler that is a whole sentence goes with its full stop.
        end += stop[0].length;
        end += /^\s*/u.exec(text.slice(end))?.[0].length ?? 0;
      } else {
        // `我觉得，嗯。` keeps the full stop, not the pause before the filler.
        const trailing = TRAILING_PAUSE.exec(out);
        out = trailing ? out.slice(0, trailing.index) : out.trimEnd();
        end += /^\s*/u.exec(text.slice(end))?.[0].length ?? 0;
        out += text.slice(end, end + stop[0].trim().length);
        end += stop[0].trim().length;
      }
    } else {
      // Spaces on both sides of a filler collapse to the one before it.
      end += /^\s*/u.exec(text.slice(end))?.[0].length ?? 0;
      const after = text.charAt(end);
      if (after === "") {
        // A filler that ends the text takes the pause before it too.
        const trailing = TRAILING_PAUSE.exec(out);
        out = trailing ? out.slice(0, trailing.index) : out.trimEnd();
      } else if (SEPARATOR.test(after)) out = out.trimEnd();
      else if (CJK.test(after) && CJK.test(shown.trimEnd().slice(-1))) out = out.trimEnd();
    }
    // A sentence that began with the filler begins with a capital.
    const lead = (before + out).trimEnd();
    if ((lead === "" || /[.!?。！？]$/u.test(lead)) && /^[A-Z]/.test(filler)) capitalize = true;
    at = end;
  }
  keep(text.slice(at));
  return out;
}

// The end of the settled text that could still become, or lose, a filler:
// pauses, a filler or the start of one, such as `U` before `m`, and spaces.
// Each part matches one way only, so a long run of them never backtracks.
const OPEN_TAIL =
  /(?:[\s\p{P}]*(?:[嗯呃啊唔]|(?<![\p{Script=Latin}\p{N}'’-])(?:[Uu](?:m+|h+|hm)?|[Ee](?:r|rm+)?|[Hh]m*)))*[\s\p{P}]*$/u;

/** One dictation's text, settled and pending, with its fillers dropped. */
export interface FillerFilter {
  /** Takes a provider update and gives the one to show. */
  update(settled: string, pending: string): { settled: string; pending: string };
  /**
   * The update to show once the provider is done, or null for none. A
   * dictation that is nothing but fillers, such as a lone 嗯, is shown as said.
   */
  finish(): { settled: string; pending: string } | null;
}

/**
 * Settled text is shown once and only appended to, so its open tail waits in
 * the pending text until what follows settles whether it is a filler.
 */
export function createFillerFilter(): FillerFilter {
  let heard = "";
  let shownUpTo = 0;
  let shown = "";
  let lastPending = "";
  return {
    update(settled, pending) {
      heard += settled;
      lastPending = pending;
      // Shown text ends in a word, so the tail is all in what is not shown.
      // A tail longer than its last 64 characters is not worth the search.
      const tail = OPEN_TAIL.exec(heard.slice(Math.max(shownUpTo, heard.length - 64)))?.[0] ?? "";
      const cut = heard.length - tail.length;
      let newlySettled = "";
      if (cut > shownUpTo) {
        newlySettled = removeFillerWords(heard.slice(shownUpTo, cut), shown);
        shown += newlySettled;
        shownUpTo = cut;
      }
      return {
        settled: newlySettled,
        pending: removeFillerWords(heard.slice(shownUpTo) + pending, shown),
      };
    },
    finish() {
      const said = (heard + lastPending).trim();
      const spoken = /[^\s\p{P}]/u;
      if (shown !== "" || !spoken.test(said) || spoken.test(removeFillerWords(said))) return null;
      return { settled: said, pending: "" };
    },
  };
}
