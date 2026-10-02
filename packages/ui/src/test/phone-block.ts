/**
 * Splits `styles.css` into its phone block (`@media (width < 48rem), (any-pointer: coarse) { … }`,
 * braces matched) and everything else, for tests that check one side. The
 * phone block re-declares tokens the rest of the sheet declares, so a test of
 * desktop values reads `rest` and a test of the phone scale reads `phone`.
 */
export const PHONE_QUERY = "@media (width < 48rem), (any-pointer: coarse)";

export function splitPhoneBlock(css: string): { phone: string; rest: string } {
  const start = css.indexOf(`${PHONE_QUERY} {\n  :root,`);
  if (start < 0) throw new Error(`No "${PHONE_QUERY}" block`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}" && (depth -= 1) === 0) {
      return {
        phone: css.slice(open + 1, index),
        rest: css.slice(0, start) + css.slice(index + 1),
      };
    }
  }
  throw new Error(`Unterminated "${PHONE_QUERY}" block`);
}
