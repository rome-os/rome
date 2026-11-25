// The shape of an account code, as typed in a message. Identity issues and
// redeems codes; Chats reads this shape to tell a code from a message.
// Vocabulary: docs/domains/identity.md#account-code.

// Digits and capitals without the look-alikes 0, 1, I, L, O and U. Twelve of
// these carry 12 × log2(30) ≈ 58.9 bits.
export const ACCOUNT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ACCOUNT_CODE_GROUP_LENGTH = 6;
export const ACCOUNT_CODE_PREFIX = "ROME";

const GROUP = `[${ACCOUNT_CODE_ALPHABET}]{${ACCOUNT_CODE_GROUP_LENGTH}}`;
const CODE = `${ACCOUNT_CODE_PREFIX}-${GROUP}-${GROUP}`;
const CODE_SHAPE = new RegExp(`^${CODE}$`);
// Searched in the upper-cased text, as the whole-text check compares it, so
// both fold case by the same rule.
const CODE_ANYWHERE = new RegExp(CODE, "g");
// What a person wraps around a code they paste alone: spaces, punctuation,
// quotes and backticks, and Telegram's `/start ` when they follow a link.
const START_COMMAND = /^\/start\s+/i;
const WRAPPING = /^[\s\p{P}`]+|[\s\p{P}`]+$/gu;

/** `text` as a code is compared: case does not count, nor what a person wraps
 *  around a code they send alone (surrounding spaces, punctuation, quotes and
 *  backticks, and a leading `/start `). */
export function normalizedAccountCode(text: string): string {
  return text.trim().replace(START_COMMAND, "").replace(WRAPPING, "").toUpperCase();
}

/** Whether a text is shaped like a code, so a caller can tell a code from an
 *  ordinary message without a database read. The whole text must be the code,
 *  as {@link normalizedAccountCode} compares it. */
export function looksLikeAccountCode(text: string): boolean {
  return CODE_SHAPE.test(normalizedAccountCode(text));
}

/** Every code-shaped token in `text`, wherever it sits, as a code is
 *  compared. Empty for a text that holds none. */
export function accountCodesIn(text: string): string[] {
  return text.toUpperCase().match(CODE_ANYWHERE) ?? [];
}
