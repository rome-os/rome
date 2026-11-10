/**
 * How an agent's text reads in the Concierge transcript. A `bubble` is a turn
 * of conversation, drawn on a fill. A `document` is read like a page: no fill,
 * at a reading width.
 */
export type MessageLayout = "bubble" | "document";

/** More lines than this, not counting blank ones, make a document. */
const MAX_BUBBLE_LINES = 6;

/** More characters than this make a document. About five lines at the bubble's widest. */
const MAX_BUBBLE_CHARS = 400;

/** A list with this many items or more makes a document. */
const LONG_LIST_ITEMS = 4;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/**
 * The layout for a text part. Text the agent sent with the `long` format is a
 * document. So is Markdown with a heading, a table, a list of
 * {@link LONG_LIST_ITEMS} items or more, or more than a few lines. Lines inside
 * a code fence count toward the length but never as a heading, table or list.
 */
export function messageLayout(markdown: string, format?: "bubble" | "long"): MessageLayout {
  if (format === "long") return "document";
  const text = markdown.trim();
  if (text.length > MAX_BUBBLE_CHARS) return "document";
  let lines = 0;
  let listItems = 0;
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim()) lines += 1;
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (HEADING.test(line) || TABLE_DELIMITER.test(line)) return "document";
    if (LIST_ITEM.test(line)) listItems += 1;
  }
  return lines > MAX_BUBBLE_LINES || listItems >= LONG_LIST_ITEMS ? "document" : "bubble";
}
