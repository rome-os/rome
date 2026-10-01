/**
 * Touch reach, evaluated in the browser via page.evaluate.
 *
 * DESIGN.md asks every touch target for 44px, reached through padding or a
 * pseudo-element hit area rather than a larger visible control. A box size
 * alone cannot say whether that holds: a hit area can be clipped by a
 * scrolling ancestor, and a neighbor's hit area can paint over it. So this
 * asks the browser instead. For each control it hit-tests the centre and, as
 * asked, the four points 21px out along each axis (the reach) and a point just
 * inside each edge of the control's own box (which no neighbour's hit area may
 * take). Every one of them must land on the control or something inside it.
 * Points past the viewport edge are pulled back onto it, because the screen
 * edge already stops a finger.
 */

export type ReachViolation = {
  element: string;
  /** Each missed point as `dx,dy -> what the point landed on`. */
  misses: string[];
};

/**
 * Serialized into the page. `scope` limits the sweep to one subtree, for a
 * surface such as the open sidebar that sits over the rest of the page.
 *
 * Skipped, because they are not touch targets at that moment: a control that
 * is hidden, disabled, inert, `pointer-events: none`, or inside a closed
 * `details`. Also skipped: a link that is a word in a running sentence,
 * which WCAG 2.5.8 exempts, since padding it would reflow the prose.
 */
export function collectTouchReachViolations({
  scope,
  ownBox,
  reach,
}: {
  scope: string | null;
  /** A point just inside each edge of the control's own box. */
  ownBox: boolean;
  /** The 44px reach: 21px out from the centre along each axis. */
  reach: boolean;
}): ReachViolation[] {
  const REACH = 21;
  const EDGE = 2;
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return [{ element: `scope ${scope}`, misses: ["not found"] }];

  const describe = (el: Element): string => {
    const slot = el.getAttribute("data-slot");
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    return `${el.tagName.toLowerCase()}${slot ? `[data-slot=${slot}]` : ""} "${name}"`;
  };

  const isTarget = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.pointerEvents === "none") {
      return false;
    }
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.closest("[inert], [aria-hidden=true]")) return false;
    if (el.tagName !== "SUMMARY" && el.closest("details:not([open])")) return false;
    return true;
  };

  const isWordInSentence = (el: Element): boolean =>
    el.tagName === "A" &&
    getComputedStyle(el).display === "inline" &&
    [...(el.parentElement?.childNodes ?? [])].some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
    );

  const controls = root.querySelectorAll(
    "button, a[href], summary, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch]",
  );
  const violations: ReachViolation[] = [];
  for (const el of [...controls]) {
    if (!isTarget(el) || isWordInSentence(el)) continue;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    if (r.right <= 0 || r.left >= window.innerWidth) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const clamp = (value: number, max: number) => Math.min(Math.max(value, 0.5), max - 0.5);
    const misses: string[] = [];
    // A point just inside each edge of the control's own box reached this
    // control before any hit area existed, and a neighbour's hit area must
    // not take it.
    const halfW = Math.max(r.width / 2 - EDGE, 0);
    const halfH = Math.max(r.height / 2 - EDGE, 0);
    const points = [[0, 0]];
    if (ownBox) points.push([-halfW, 0], [halfW, 0], [0, -halfH], [0, halfH]);
    if (reach) points.push([-REACH, 0], [REACH, 0], [0, -REACH], [0, REACH]);
    for (const [dx, dy] of points) {
      const hit = document.elementFromPoint(
        clamp(cx + dx, window.innerWidth),
        clamp(cy + dy, window.innerHeight),
      );
      if (hit && (hit === el || el.contains(hit))) continue;
      misses.push(`${Math.round(dx)},${Math.round(dy)} -> ${hit ? describe(hit) : "nothing"}`);
    }
    if (misses.length > 0) {
      violations.push({
        element: `${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        misses,
      });
    }
  }
  window.scrollTo(0, 0);
  return violations;
}

/** Serialized into the page. How far the document scrolls sideways, in px. */
export function measureHorizontalOverflow(): number {
  const { scrollWidth } = document.documentElement;
  return Math.max(scrollWidth, document.body.scrollWidth) - window.innerWidth;
}
