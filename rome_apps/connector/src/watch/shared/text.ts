// Text from a watched source, made fit to read: subjects and excerpts lose the
// invisible and padding characters senders hide in them (marketing mail pads
// its preview with runs of combining grapheme joiners and zero-width spaces),
// and an excerpt is cut to a fixed length. Every source puts its text through
// here, so the rule is one.

export const EXCERPT_CHARS = 500;

/**
 * Characters that show nothing: soft hyphen, combining grapheme joiner, the
 * zero-width and directional marks, word joiners and invisible operators,
 * Hangul and Mongolian fillers, variation selectors, and the BOM.
 */
const INVISIBLE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
/** Spaces of every width, read as one plain space. */
const SPACES = /[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g;

/** The text without invisible characters, its spaces collapsed to one, trimmed. */
export function cleanText(text: string): string {
  return text.replace(INVISIBLE, "").replace(SPACES, " ").trim();
}

/** A cleaned subject, or undefined when nothing visible is left. */
export function subjectOf(text: string | undefined): string | undefined {
  const cleaned = text === undefined ? "" : cleanText(text);
  return cleaned || undefined;
}

/** A cleaned excerpt cut to EXCERPT_CHARS, or undefined when nothing visible is left. */
export function excerptOf(text: string | undefined): string | undefined {
  const cleaned = text === undefined ? "" : cleanText(text);
  if (!cleaned) return undefined;
  return cleaned.length > EXCERPT_CHARS ? `${cleaned.slice(0, EXCERPT_CHARS)}…` : cleaned;
}
