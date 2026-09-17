/**
 * The typography roles `styles.css` declares under Tailwind's `--text-*`
 * namespace, mirrored here because the class merger has to be told about them
 * in JavaScript (see `cn.ts`).
 *
 * This list and the stylesheet must hold exactly the same names, in both
 * directions:
 *
 *   - A role in the stylesheet but missing here is not a font size to
 *     tailwind-merge, so it lands in the text-color group and a caller's
 *     `text-muted-foreground` deletes it.
 *   - A name here that the stylesheet no longer declares keeps claiming the
 *     font-size group for `text-<name>`. Should that name later become a color
 *     token, two conflicting colors would survive a merge and CSS order — not
 *     the caller — would pick the winner.
 *
 * Neither failure produces a build or type error, so `cn.test.ts` parses the
 * stylesheet and asserts set equality against this list.
 *
 * Deliberately not exported from the package: `package.json` maps a subpath per
 * module, and this one has no entry, so the roles stay an internal detail
 * rather than published API.
 */
export const TYPOGRAPHY_ROLES = ["display", "title", "section", "composer", "ui", "badge", "aux"];
