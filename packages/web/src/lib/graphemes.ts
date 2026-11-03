const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter() : null;

/** Splits text into grapheme clusters, so a caller never tears an emoji, flag,
 *  or ZWJ sequence (UTF-16 slicing would leave half a surrogate pair). Falls
 *  back to code points where Intl.Segmenter is unavailable — still
 *  surrogate-safe, but it splits combining sequences. */
export function splitGraphemes(text: string): string[] {
  if (!text) return [];
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}
