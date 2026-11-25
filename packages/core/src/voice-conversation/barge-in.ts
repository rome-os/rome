// Whether what Rome hears while it speaks is the guardian talking over it.
// Loudness cannot tell: on an iPhone the guardian's voice barely rises above
// the room. So it goes by recognised words: at least three Chinese characters
// or two English words, that are not just Rome's own speech coming back
// through the microphone.

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_WORD = /[\p{Script=Latin}\p{N}]+(?:['’][\p{Script=Latin}]+)?/gu;

const BARGE_IN_CJK_CHARS = 3;
const BARGE_IN_LATIN_WORDS = 2;

/** Whether `heard` holds enough words to be the guardian speaking. */
export function enoughWords(heard: string): boolean {
  const cjk = heard.match(CJK_CHAR)?.length ?? 0;
  const latin = heard.replace(CJK_CHAR, " ").match(LATIN_WORD)?.length ?? 0;
  return cjk >= BARGE_IN_CJK_CHARS || latin >= BARGE_IN_LATIN_WORDS;
}

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Whether every word of `heard` is in what Rome said: its own voice, not the guardian's. */
export function isEcho(heard: string, said: string): boolean {
  const words = normalize(heard);
  return words !== "" && normalize(said).includes(words);
}

/**
 * Whether `heard` is exactly Rome's last sentence, or its last few: the late
 * echo of audio that has already played. Part of a sentence is the guardian
 * picking from what Rome said, as in "下午的航班". `after` is what Rome
 * played since the turn began: any of its words may come back too, following
 * the whole sentences or on their own.
 */
export function isLateEcho(
  heard: string,
  sentences: readonly string[],
  after: readonly string[] = [],
): boolean {
  const words = normalize(heard);
  if (words === "") return false;
  const next = normalize(after.join(" "));
  if (next !== "" && next.includes(words)) return true;
  let tail = "";
  for (let i = sentences.length - 1; i >= 0; i--) {
    tail = normalize(sentences[i] as string) + tail;
    if (tail.length > words.length) break;
    if (words.startsWith(tail) && next.startsWith(words.slice(tail.length))) return true;
  }
  return false;
}
