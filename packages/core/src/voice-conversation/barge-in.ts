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
