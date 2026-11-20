// Hard checks for the Concierge's standing rules, which every baseline
// scenario runs, and the Chinese style checks its Chinese scenarios add.
// Each note starts with `rule:` or `zh:`, so the report counts them apart
// from a scenario's own checks. Pure, so they are tested apart from a stack.
// docs/concierge-eval.md#rules

/** One emoji, with its variation selector and any joined emoji that make it one glyph. */
const EMOJI = /\p{Extended_Pictographic}\u{FE0F}?(\u{200D}\p{Extended_Pictographic}\u{FE0F}?)*/gu;

export function emojiCount(text: string): number {
  return text.match(EMOJI)?.length ?? 0;
}

/** At most one emoji in each message. */
export function oneEmoji(said: string[]): string[] {
  return said
    .filter((t) => emojiCount(t) > 1)
    .map((t) => `rule: ${emojiCount(t)} emoji in "${t.slice(0, 60)}"`);
}

/** A message that sends the owner to the task chat instead of carrying the result. */
const TASK_CHAT_POINTER =
  /\b(see|check|open|look at|details (are )?in) (the |its |that )?task( chat)?\b|\bin the task chat\b|(查看|打开|点开|去看|看看)(一下)?(这个|该|那个)?任务|详(情|细)(见|在|请看)任务/i;

export function noTaskChatPointer(said: string[]): string[] {
  return said
    .filter((t) => TASK_CHAT_POINTER.test(t))
    .map((t) => `rule: points to the task chat: "${t.slice(0, 60)}"`);
}

/** An offer of more help or a question to the owner, as an answer's last sentence. */
const OFFER =
  /\b(want me to|shall i|should i|would you like|do you want|let me know if|if you('d| would)? like|happy to|i can also|need (anything|help) else|anything else)\b|需要我|要不要我|要我(帮|再)|如果(你|您)(需要|想)|随时(告诉|找)我|我(也)?可以(帮|再)|还有(什么|别的)/i;

/** The last sentence of `text`. */
function lastSentence(text: string): string {
  const sentences = text
    .trim()
    .split(/(?<=[.!?。！？])\s*|\n+/)
    .filter((s) => s.trim());
  return sentences.at(-1)?.trim() ?? "";
}

/**
 * A simple answer ends on the answer: no question back and no offer of
 * more. `said` is what the Concierge said after the owner's message.
 */
export function noTrailingOffer(said: string[], step: number): string[] {
  const last = said.at(-1);
  if (!last) return [];
  const sentence = lastSentence(last);
  if (/[?？]\s*$/.test(sentence) || OFFER.test(sentence)) {
    return [`rule: step ${step + 1} ends with an offer or a question: "${sentence.slice(0, 80)}"`];
  }
  return [];
}

/**
 * A thanks gets no 👀: neither the working status, which a turn sets once a
 * tool runs, nor a 👀 reaction.
 */
export function thanksWithoutEyes(
  turn: { workingMs: number | null } | null,
  reaction: string | null | undefined,
  step: number,
): string[] {
  const notes: string[] = [];
  if (turn?.workingMs != null) notes.push(`rule: step ${step + 1} showed 👀 working for a thanks`);
  if (reaction === "👀") notes.push(`rule: step ${step + 1} reacted 👀 to a thanks`);
  return notes;
}

const CJK = /[\u{3400}-\u{9FFF}]/gu;
const LATIN = /[A-Za-z]/g;

/** Half-width punctuation that touches a Chinese character. */
const HALF_WIDTH =
  /[\u{3400}-\u{9FFF}] ?[,;:!?]|[,;:!?] ?[\u{3400}-\u{9FFF}]|[\u{3400}-\u{9FFF}]\.(?=\s|$)/u;

/** Checks a Chinese reply: it is in Chinese and uses full-width punctuation. */
export function chineseStyle(said: string[]): string[] {
  const notes: string[] = [];
  for (const t of said) {
    const cjk = t.match(CJK)?.length ?? 0;
    const latin = t.match(LATIN)?.length ?? 0;
    // A reply of a name or a number only, say "Porto" or "11:30", is no language.
    if (cjk + latin >= 8 && cjk < latin / 4) notes.push(`zh: not Chinese: "${t.slice(0, 60)}"`);
    const half = t.match(HALF_WIDTH);
    if (half) notes.push(`zh: half-width punctuation "${half[0]}" in "${t.slice(0, 60)}"`);
  }
  return notes;
}

/** The opening and closing markers of a task chat's conclusion section. */
const CONCLUSION = /<!--\s*rome:conclusion\s*-->([\s\S]*?)(?:<!--\s*\/rome:conclusion\s*-->|$)/g;

/** The conclusion of a task chat's answer: its last conclusion section, trimmed, or null. */
export function conclusionIn(answer: string): string | null {
  const last = [...answer.matchAll(CONCLUSION)].at(-1)?.[1]?.trim();
  return last || null;
}

/** What the Concierge must keep exactly when it tells a conclusion in its own words. */
const SPECIFICS: readonly RegExp[] = [
  // A URL, without the punctuation that ends its sentence.
  /https?:\/\/[^\s<>"'`)\]，。）]+/g,
  // A UUID, then a hex id of seven or more digits that mixes letters and digits.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi,
  // A pull request or issue number.
  /#\d+\b/g,
  // A version: two or more dotted numbers, with a leading v or a suffix.
  /\bv?\d+(?:\.\d+){2,}(?:[-+][0-9A-Za-z.-]+)?/g,
  // A number with a decimal point or a thousands separator, or with a unit or a currency sign.
  /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+/g,
  /(?<=[$€£¥])\d[\d,]*/g,
  /\d+(?:\.\d+)?(?=\s?(?:%|°|km|kg|ms|min|bpm|GB|MB|KB|TB|元|美元|公里|小时|分钟)(?![A-Za-z]))/g,
];

/** The URLs, versions, ids, PR numbers and measured numbers in `conclusion`, each once. A bare integer is no specific. */
export function specificsOf(conclusion: string): string[] {
  const found: string[] = [];
  let rest = conclusion;
  // A token is cut out once found, so a version inside a URL, or a decimal
  // inside a version, is not a second token.
  for (const pattern of SPECIFICS) {
    for (const match of rest.matchAll(pattern)) {
      found.push(match[0].replace(/[.,;:!?]+$/, ""));
    }
    rest = rest.replace(pattern, " ");
  }
  return [...new Set(found.filter(Boolean))];
}

/**
 * A result the Concierge tells in its own words keeps the conclusion's
 * specifics exactly: each URL, version, id, PR number and measured number of
 * a task's conclusion appears verbatim in what the Concierge said. A result
 * sent as a forwarded card is not told in words, so `cardForwarded` skips the
 * check, and so does a conclusion with no news.
 */
export function exactSpecifics(
  conclusions: string[],
  said: string[],
  cardForwarded: boolean,
): string[] {
  if (cardForwarded) return [];
  const told = said.join("\n");
  return conclusions
    .filter((conclusion) => conclusion !== "Nothing to report.")
    .flatMap(specificsOf)
    .filter((token) => !told.includes(token))
    .map((token) => `rule: result drops "${token.slice(0, 60)}" from the conclusion`);
}
