// How rule 3 counts wrong words and characters. The normalisation is part of the pass bar,
// so README.md states it in prose and a change here is a verifier change.

const CJK = /[㐀-鿿豈-﫿]/u;

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** British spellings in the script mapped to the American ones transcribers tend to write. */
const SPELLING = new Map([
  ["travellers", "travelers"],
  ["traveller", "traveler"],
  ["travelling", "traveling"],
  ["colour", "color"],
  ["favourite", "favorite"],
  ["organise", "organize"],
  ["organisation", "organization"],
  ["splendours", "splendors"],
]);

function englishNumber(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000)
    return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${englishNumber(n % 100)}` : ""}`;
  if (n < 1_000_000)
    return `${englishNumber(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${englishNumber(n % 1000)}` : ""}`;
  return String(n);
}

const ZH_DIGITS = "零一二三四五六七八九";

function chineseNumber(n) {
  if (n < 10) return ZH_DIGITS[n];
  if (n < 20) return `十${n % 10 ? ZH_DIGITS[n % 10] : ""}`;
  if (n < 100) return `${ZH_DIGITS[Math.floor(n / 10)]}十${n % 10 ? ZH_DIGITS[n % 10] : ""}`;
  if (n < 1000) {
    const rest = n % 100;
    const tail = rest === 0 ? "" : rest < 10 ? `零${ZH_DIGITS[rest]}` : chineseTens(rest);
    return `${ZH_DIGITS[Math.floor(n / 100)]}百${tail}`;
  }
  return [...String(n)].map((d) => ZH_DIGITS[Number(d)]).join("");
}

function chineseTens(n) {
  return `${ZH_DIGITS[Math.floor(n / 10)]}十${n % 10 ? ZH_DIGITS[n % 10] : ""}`;
}

/**
 * The tokens rule 3 compares. English: lower-case words, punctuation dropped (an apostrophe
 * inside a word is kept), hyphens split words, numbers written as words, British spellings
 * mapped to American. Mandarin and mixed: one token per Chinese character and one per Latin
 * word, punctuation and spaces dropped, numbers written in Chinese numerals, a four-digit
 * number before 年 read digit by digit. Full-width forms fold to half-width (NFKC) first.
 */
export function tokens(text, language) {
  let s = text.normalize("NFKC").toLowerCase();
  if (language === "en") {
    s = s.replace(/\d+/g, (d) => ` ${englishNumber(Number(d))} `);
    s = s.replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ");
    return s
      .split(" ")
      .map((w) => w.replace(/^'+|'+$/g, ""))
      .filter(Boolean)
      .map((w) => SPELLING.get(w) ?? w);
  }
  s = s.replace(/(\d{4})(?=年)/g, (d) => [...d].map((c) => ZH_DIGITS[Number(c)]).join(""));
  s = s.replace(/\d+/g, (d) => chineseNumber(Number(d)));
  const out = [];
  for (const part of s.split(/[^\p{L}\p{N}']+/u)) {
    let word = "";
    for (const ch of part) {
      if (CJK.test(ch)) {
        if (word) out.push(word);
        word = "";
        out.push(ch);
      } else {
        word += ch;
      }
    }
    if (word) out.push(word.replace(/^'+|'+$/g, ""));
  }
  return out.filter(Boolean);
}

/** Levenshtein distance over tokens: substitutions, deletions and insertions, each counting 1. */
export function editDistance(ref, hyp) {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[hyp.length];
}

/** Wrong tokens of `heard` against the written text, and how many tokens the written text has. */
export function errors(written, heard, language) {
  const ref = tokens(written, language);
  return { wrong: editDistance(ref, tokens(heard ?? "", language)), of: ref.length };
}

/** Wrong tokens in 100 over a pool of `{ wrong, of }`, rounded to one decimal. */
export function per100(pool) {
  const wrong = pool.reduce((sum, p) => sum + p.wrong, 0);
  const of = pool.reduce((sum, p) => sum + p.of, 0);
  return of === 0 ? null : Math.round((wrong / of) * 1000) / 10;
}

/**
 * How well `part` appears somewhere in `whole`: the fewest wrong tokens over any stretch of
 * `whole`, and how many tokens `part` has. Rule 4 finds the first and last sentences this way,
 * and rule 7 the words heard before a stop.
 */
export function errorsWithin(part, whole, language) {
  const ref = tokens(part, language);
  const hyp = tokens(whole ?? "", language);
  // Edit distance where the stretch of `whole` may start and end anywhere at no cost.
  let prev = new Array(hyp.length + 1).fill(0);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return { wrong: Math.min(...prev), of: ref.length };
}
