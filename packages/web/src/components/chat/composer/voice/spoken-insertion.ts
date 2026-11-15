const HAN = /\p{Script=Han}/u;

/**
 * Whether a space belongs between `left` and `right`, as a guardian typing
 * would add one: before a word, after anything but a space. Chinese takes none.
 */
function needsSpace(left: string, right: string): boolean {
  if (!left || /\s/.test(left) || HAN.test(left) || HAN.test(right)) return false;
  return /[\p{L}\p{N}]/u.test(right);
}

/**
 * The spoken text as it lands between `before` and `after`: a space separates
 * it from a word right before or right after the cursor. Chinese takes none.
 */
export function spokenInsertion(before: string, heard: string, after = ""): string {
  const text = heard.trim();
  if (!text) return "";
  const lead = needsSpace(before.slice(-1), text[0]) ? " " : "";
  const trail = needsSpace(text.slice(-1), after[0] ?? "") ? " " : "";
  return lead + text + trail;
}
