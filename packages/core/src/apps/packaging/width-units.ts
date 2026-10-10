/**
 * Display width of a string in card units: CJK and other fullwidth code
 * points (above U+2E7F) count 2, everything else 1. Shared by the manifest
 * `tagline` rule and the social-card template so "80 units" means the same
 * thing at validation time and at render time.
 */
export function widthUnits(text: string): number {
  let total = 0;
  for (const ch of text) total += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return total;
}
