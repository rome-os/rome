// The shape of an account code, as typed in a message. Identity issues and
// redeems codes; a connection that reports a bare command after mentions
// reads this shape too, as it reads a stop command's. Vocabulary:
// docs/domains/identity.md#account-code.

// Digits and capitals without the look-alikes 0, 1, I, L, O and U. Twelve of
// these carry 12 × log2(30) ≈ 58.9 bits.
export const ACCOUNT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ACCOUNT_CODE_GROUP_LENGTH = 6;
export const ACCOUNT_CODE_PREFIX = "ROME";

const CODE_SHAPE = new RegExp(
  `^${ACCOUNT_CODE_PREFIX}-[${ACCOUNT_CODE_ALPHABET}]{${ACCOUNT_CODE_GROUP_LENGTH}}-[${ACCOUNT_CODE_ALPHABET}]{${ACCOUNT_CODE_GROUP_LENGTH}}$`,
);

/** `text` as a code is compared: case and surrounding spaces do not count. */
export function normalizedAccountCode(text: string): string {
  return text.trim().toUpperCase();
}

/** Whether a text is shaped like a code, so a caller can tell a code from an
 *  ordinary message without a database read. The whole text must be the code,
 *  ignoring case and surrounding spaces. */
export function looksLikeAccountCode(text: string): boolean {
  return CODE_SHAPE.test(normalizedAccountCode(text));
}
