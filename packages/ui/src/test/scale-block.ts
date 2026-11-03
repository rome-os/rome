export const LARGE_SCALE_SELECTOR = '[data-ui-scale="large"],\n:host([data-ui-scale="large"])';

export function splitLargeScale(css: string): { large: string; rest: string } {
  const start = css.indexOf(`${LARGE_SCALE_SELECTOR} {`);
  if (start < 0) throw new Error(`No "${LARGE_SCALE_SELECTOR}" block`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}" && (depth -= 1) === 0) {
      return {
        large: css.slice(open + 1, index),
        rest: css.slice(0, start) + css.slice(index + 1),
      };
    }
  }
  throw new Error(`Unterminated "${LARGE_SCALE_SELECTOR}" block`);
}
