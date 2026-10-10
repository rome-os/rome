/**
 * Relational layout invariants, evaluated in the browser via page.evaluate.
 *
 * Every check asserts a *relationship* between rendered boxes (containment,
 * centering, symmetry, sibling uniformity) rather than any absolute pixel
 * value, so the suite survives restyling: thresholds are em-relative or
 * proportional to the element's own padding. A violation names the element,
 * the invariant, and the measured values — enough for an agent to act on.
 */

export type Violation = {
  invariant: string;
  /** CSS-path-ish description of the offending element. */
  element: string;
  detail: string;
};

/**
 * Serialized into the page. Sweeps every visible `[data-slot="button"]`
 * control and applies:
 *
 * - `content-breathing-room`: any "media" child (taller than 1.5em — an
 *   embedded badge/avatar/thumbnail, not a text glyph) must sit at least
 *   0.4em clear of the control's top and bottom edges. Glyph-sized icons are
 *   exempt: controls legitimately run tight around plain icons.
 * - `inset-proportionality`: a media child's vertical clearance must be at
 *   least a third of the control's horizontal padding — padding that is
 *   generous on one axis and starved on the other reads as broken.
 * - `vertical-centering`: every direct child is centered in the control
 *   (±1.5px).
 * - `sibling-uniformity`: controls that are siblings in the same flex/grid
 *   column have equal heights (±1px). A wrapping control is exempt — its
 *   height follows its label rather than a step, so it is not comparable to a
 *   fixed-step sibling.
 */
export function collectButtonViolations(): Violation[] {
  const violations: {
    invariant: string;
    element: string;
    detail: string;
  }[] = [];

  const describe = (el: Element): string => {
    const slot = el.getAttribute("data-slot");
    const size = el.getAttribute("data-size");
    const text = (el.textContent ?? "").trim().slice(0, 40);
    return `[data-slot=${slot}${size ? ` data-size=${size}` : ""}] "${text}"`;
  };

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  const buttons = [...document.querySelectorAll('[data-slot="button"]')].filter(isVisible);

  for (const btn of buttons) {
    const rect = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    const em = Number.parseFloat(cs.fontSize) || 16;
    const padX = Math.max(Number.parseFloat(cs.paddingLeft), Number.parseFloat(cs.paddingRight));

    // The layout box, not the painted one. `getBoundingClientRect` reports the
    // box after transforms, and a spinning 16px glyph paints a 22px square
    // midway through each turn, which would read as media on some frames
    // and as a glyph on others. Transforms rotate about the center, so the
    // center is taken from the painted box and the extent from the computed
    // size; an element with no computed size keeps its painted box.
    const layoutBox = (el: Element) => {
      const painted = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const width = Number.parseFloat(cs.width);
      const height = Number.parseFloat(cs.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return painted;
      const cy = (painted.top + painted.bottom) / 2;
      return { top: cy - height / 2, bottom: cy + height / 2, width, height };
    };

    // Walk descendants, keeping elements that render as visual boxes.
    const descendants = [...btn.querySelectorAll("*")].filter(isVisible);

    for (const child of descendants) {
      const c = layoutBox(child);
      const isMedia = c.height > 1.5 * em;
      if (!isMedia) continue;
      // Only flag leaf media: a wrapper whose height comes from a media
      // descendant would duplicate that descendant's finding.
      const hasMediaDescendant = [...child.children].some(
        (grandchild) => layoutBox(grandchild).height > 1.5 * em,
      );
      if (hasMediaDescendant) continue;

      const clearance = Math.min(c.top - rect.top, rect.bottom - c.bottom);

      const minBreathing = 0.4 * em;
      if (clearance < minBreathing) {
        violations.push({
          invariant: "content-breathing-room",
          element: describe(btn),
          detail:
            `media child (${Math.round(c.width)}x${Math.round(c.height)}) has ` +
            `${clearance.toFixed(1)}px vertical clearance; needs >= ${minBreathing.toFixed(1)}px (0.4em)`,
        });
      }

      if (padX > 0 && clearance < padX / 3) {
        violations.push({
          invariant: "inset-proportionality",
          element: describe(btn),
          detail:
            `vertical clearance ${clearance.toFixed(1)}px vs horizontal padding ${padX}px; ` +
            `needs >= ${(padX / 3).toFixed(1)}px (padX/3)`,
        });
      }
    }

    for (const child of [...btn.children].filter(isVisible)) {
      const c = child.getBoundingClientRect();
      const drift = Math.abs((c.top + c.bottom) / 2 - (rect.top + rect.bottom) / 2);
      if (drift > 1.5) {
        violations.push({
          invariant: "vertical-centering",
          element: describe(btn),
          detail: `direct child off vertical center by ${drift.toFixed(1)}px`,
        });
      }
    }
  }

  // Sibling uniformity: group visible buttons by parent, compare heights.
  //
  // A wrapping control is left out of the comparison. Its height is whatever
  // its label needs, so holding it to a fixed-step sibling would report every
  // multi-line option in a stacked list as a defect. The Button base is
  // `whitespace-nowrap`, so anything else is a deliberate opt-in to wrapping
  // and therefore out of the step vocabulary — the same reasoning that keeps
  // Badge, Switch, and TabsTrigger out of the row comparison below.
  const byParent = new Map<Element, Element[]>();
  for (const btn of buttons) {
    if (getComputedStyle(btn).whiteSpace !== "nowrap") continue;
    const parent = btn.parentElement;
    if (!parent) continue;
    const group = byParent.get(parent) ?? [];
    group.push(btn);
    byParent.set(parent, group);
  }
  for (const [parent, group] of byParent) {
    if (group.length < 2) continue;
    const heights = group.map((b) => b.getBoundingClientRect().height);
    const spread = Math.max(...heights) - Math.min(...heights);
    if (spread > 1) {
      violations.push({
        invariant: "sibling-uniformity",
        element: `${group.length} sibling buttons under ${parent.tagName.toLowerCase()}`,
        detail: `heights vary by ${spread.toFixed(1)}px: [${heights.map((h) => h.toFixed(0)).join(", ")}]`,
      });
    }
  }

  return violations;
}

/**
 * Serialized into the page. Groups every element's children into *visual rows*
 * — siblings that overlap vertically and sit side by side horizontally — and
 * asserts `row-height-uniformity`: the comparable items on one row have equal
 * heights (±1px).
 *
 * Rows are derived from geometry, not from the parent's `display`, so flex,
 * inline-block, grid and float rows are all covered by the same rule, and a
 * *wrapped* flex container yields one row per rendered line instead of one
 * group that compares across lines.
 *
 * "Comparable" means both items read the `--control-h-*` scale — the shared
 * `sm`/`md` size vocabulary, whose whole promise is that "a row that names one
 * size cannot come out ragged". Two of its readers disagreeing means someone
 * bypassed it. Everything else on a row — text, icons, wrappers, and the
 * primitives listed below — is aligned by centering, and differing heights
 * there are correct rather than defects.
 *
 * Note this function cannot call the helpers above: `page.evaluate` ships the
 * function's own source into the browser, so module scope isn't there.
 */
export function collectRowHeightViolations(): Violation[] {
  const violations: Violation[] = [];

  // Exactly the primitives that size themselves off `--control-h-*`, verified
  // against their sources rather than inferred from being "a control".
  //
  // Four kit primitives are deliberately absent because they carry their own
  // geometry, and comparing them here reports correct layout as broken:
  // `switch` is a 12/16px toggle track, `badge` is `--badge-h` (22px), and
  // `tabs-trigger` is a 32px underline tab. `textarea` is absent too — it is
  // multi-line, so `min-h-16` plus content decides its height.
  //
  // Two members join by composition rather than by naming the tokens:
  // `toggle` renders through `buttonVariants`, and `icon-button` sizes as
  // `size-[var(--control-h-*)]` so a square trigger and a field named the same
  // step are the same box.
  const controlSlots = new Set([
    "button",
    "icon-button",
    "input",
    "segmented-control",
    "select-trigger",
    "toggle",
  ]);

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  const describe = (el: Element): string => {
    const slot = el.getAttribute("data-slot");
    const size = el.getAttribute("data-size");
    const text = (el.textContent ?? "").trim().slice(0, 24);
    const head = slot
      ? `[data-slot=${slot}${size ? ` data-size=${size}` : ""}]`
      : `<${el.tagName.toLowerCase()}>`;
    return text ? `${head} "${text}"` : head;
  };

  const isComparable = (el: Element): boolean =>
    controlSlots.has(el.getAttribute("data-slot") ?? "");

  /**
   * Partition a parent's visible children into rendered lines. Two children
   * share a line when their vertical spans overlap and their horizontal spans
   * do not — i.e. they are actually beside each other, not stacked.
   */
  const rowsOf = (parent: Element): Element[][] => {
    const children = [...parent.children].filter(isVisible);
    if (children.length < 2) return [];

    const measured = children
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => a.r.left - b.r.left);

    const rows: { el: Element; r: DOMRect }[][] = [];
    for (const item of measured) {
      const row = rows.find((existing) =>
        existing.every(({ r }) => {
          const vOverlap = Math.min(item.r.bottom, r.bottom) - Math.max(item.r.top, r.top);
          const hOverlap = Math.min(item.r.right, r.right) - Math.max(item.r.left, r.left);
          return vOverlap > 0 && hOverlap <= 1;
        }),
      );
      if (row) row.push(item);
      else rows.push([item]);
    }

    return rows.filter((row) => row.length >= 2).map((row) => row.map(({ el }) => el));
  };

  for (const parent of document.querySelectorAll("*")) {
    for (const row of rowsOf(parent)) {
      const items = row.filter(isComparable);
      if (items.length < 2) continue;

      // Every item in a row shares a parent, so an all-button row is exactly a
      // group `sibling-uniformity` already owns. Reporting it here too would
      // surface one defect under two invariant names.
      if (items.every((el) => el.getAttribute("data-slot") === "button")) continue;

      const heights = items.map((el) => el.getBoundingClientRect().height);
      const spread = Math.max(...heights) - Math.min(...heights);
      if (spread <= 1) continue;

      violations.push({
        invariant: "row-height-uniformity",
        element: `${items.length} row items under ${describe(parent)}`,
        detail:
          `heights vary by ${spread.toFixed(1)}px: ` +
          items.map((el, i) => `${describe(el)}=${heights[i].toFixed(0)}px`).join(", "),
      });
    }
  }

  return violations;
}
