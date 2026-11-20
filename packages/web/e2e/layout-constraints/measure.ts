import type { Constraint, Finding } from "./types.js";

/**
 * Serialized into the page by `page.evaluate`, so it holds every helper it
 * needs: module scope does not travel with it. Returns one finding per broken
 * constraint group, and one per stale locator.
 */
export function evaluateConstraints(constraints: Constraint[]): Finding[] {
  type L = Constraint["scope"];
  type R = { left: number; top: number; right: number; bottom: number };
  // React fibers carry the component tree in dev builds. A minimal shape of
  // what this file reads from them.
  type Fiber = {
    tag: number;
    type: unknown;
    memoizedProps: Record<string, unknown> | null;
    return: Fiber | null;
    child: Fiber | null;
    sibling: Fiber | null;
    stateNode: unknown;
    alternate: Fiber | null;
  };
  const HOST = 5;
  const MEMO_WRAPPER = 14;

  const fiberOf = (el: Element): Fiber | null => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
  };
  const nameOf = (f: Fiber): string | undefined => {
    if (f.tag === MEMO_WRAPPER) return undefined;
    const t = f.type as
      | ({
          displayName?: string;
          name?: string;
          render?: { displayName?: string; name?: string };
        } & object)
      | null;
    if (typeof t === "function" || (t && typeof t === "object")) {
      return t.displayName || t.name || t.render?.displayName || t.render?.name || undefined;
    }
    return undefined;
  };
  const hostRoots = (f: Fiber): Element[] => {
    const out: Element[] = [];
    const walk = (node: Fiber | null) => {
      for (let n = node; n; n = n.sibling) {
        if (n.tag === HOST && n.stateNode instanceof Element) out.push(n.stateNode);
        else walk(n.child);
      }
    };
    walk(f.child);
    return out;
  };

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };

  const IMPLICIT: Record<string, string> = {
    BUTTON: "button",
    A: "link",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    TEXTAREA: "textbox",
    IMG: "img",
    NAV: "navigation",
    MAIN: "main",
  };
  const roleOf = (el: Element) => el.getAttribute("role") ?? IMPLICIT[el.tagName] ?? null;
  const accName = (el: Element) =>
    (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();

  // A match is the set of root elements one locator hit stands for: one
  // element, or every root of one component instance.
  const resolve = (loc: L, roots: Element[]): Element[][] => {
    const inside = loc.within ? resolve(loc.within, roots).flat() : roots;
    let matches: Element[][] = [];
    if (loc.component) {
      const seen = new Set<Fiber>();
      for (const root of inside) {
        for (const el of [root, ...root.querySelectorAll("*")]) {
          for (let f = fiberOf(el); f; f = f.return) {
            if (nameOf(f) !== loc.component) continue;
            if (seen.has(f) || (f.alternate && seen.has(f.alternate))) break;
            seen.add(f);
            const props = f.memoizedProps ?? {};
            const ok = Object.entries(loc.props ?? {}).every(([k, v]) => props[k] === v);
            const els = hostRoots(f).filter((e) => inside.some((r) => r.contains(e)));
            if (ok && els.length > 0) matches.push(els);
            break;
          }
        }
      }
      // Fiber walks visit instances in no particular order; keep document order.
      matches.sort((a, b) =>
        a[0] === b[0]
          ? 0
          : a[0].compareDocumentPosition(b[0]) & Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
      );
    } else {
      const found = new Set<Element>();
      for (const root of inside) {
        for (const el of [root, ...root.querySelectorAll(loc.css ?? "*")]) {
          if (loc.css && !el.matches(loc.css)) continue;
          found.add(el);
        }
      }
      matches = [...found].map((el) => [el]);
    }
    matches = matches.filter((els) =>
      els.every(
        (el) =>
          (!loc.testid || el.getAttribute("data-testid") === loc.testid) &&
          (!loc.role || roleOf(el) === loc.role) &&
          (loc.name === undefined || accName(el) === loc.name) &&
          (!loc.css || !loc.component || el.matches(loc.css)),
      ),
    );
    matches = matches.filter((els) => els.some(visible));
    if (loc.nth !== undefined) {
      const m = matches.at(loc.nth);
      return m ? [m] : [];
    }
    return matches;
  };

  const union = (rs: R[]): R | null =>
    rs.length === 0
      ? null
      : {
          left: Math.min(...rs.map((r) => r.left)),
          top: Math.min(...rs.map((r) => r.top)),
          right: Math.max(...rs.map((r) => r.right)),
          bottom: Math.max(...rs.map((r) => r.bottom)),
        };
  const toR = (d: DOMRect): R => ({ left: d.left, top: d.top, right: d.right, bottom: d.bottom });
  const nonEmpty = (r: R) => r.right - r.left > 0 && r.bottom - r.top > 0;

  const box = (el: Element) => toR(el.getBoundingClientRect());
  const content = (el: Element): R => {
    const r = box(el);
    const s = getComputedStyle(el);
    const px = (p: string) => Number.parseFloat(s.getPropertyValue(p)) || 0;
    return {
      left: r.left + px("border-left-width") + px("padding-left"),
      right: r.right - px("border-right-width") - px("padding-right"),
      top: r.top + px("border-top-width") + px("padding-top"),
      bottom: r.bottom - px("border-bottom-width") - px("padding-bottom"),
    };
  };
  const text = (el: Element): R => {
    const rects: R[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim() || !n.parentElement || !visible(n.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0) rects.push(toR(r));
    }
    return union(rects) ?? content(el);
  };
  const ink = (el: Element): R => {
    const svgs = el instanceof SVGSVGElement ? [el] : [...el.querySelectorAll("svg")];
    const rects: R[] = [];
    for (const svg of svgs) {
      for (const shape of svg.querySelectorAll<SVGGraphicsElement>(
        "path, circle, rect, line, polyline, polygon, ellipse, text, use",
      )) {
        const b = shape.getBBox();
        const m = shape.getScreenCTM();
        if (!m || (b.width === 0 && b.height === 0)) continue;
        // Stroke widens the drawn ink past the geometric box by half its width.
        const half = (Number.parseFloat(getComputedStyle(shape).strokeWidth) || 0) / 2;
        const pts = [
          new DOMPoint(b.x - half, b.y - half),
          new DOMPoint(b.x + b.width + half, b.y + b.height + half),
        ].map((p) => p.matrixTransform(m));
        rects.push({
          left: Math.min(pts[0].x, pts[1].x),
          right: Math.max(pts[0].x, pts[1].x),
          top: Math.min(pts[0].y, pts[1].y),
          bottom: Math.max(pts[0].y, pts[1].y),
        });
      }
    }
    return union(rects) ?? text(el);
  };
  const LEVEL = { box, content, text, ink };
  const edgeOf = (r: R, e: string) =>
    ({
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      centerX: (r.left + r.right) / 2,
      centerY: (r.top + r.bottom) / 2,
      width: r.right - r.left,
      height: r.bottom - r.top,
    })[e] as number;

  const describe = (loc: L): string =>
    [
      loc.component && `<${loc.component}${loc.props ? ` ${JSON.stringify(loc.props)}` : ""}>`,
      loc.role && `role=${loc.role}`,
      loc.name !== undefined && `name="${loc.name}"`,
      loc.testid && `testid=${loc.testid}`,
      loc.css,
      loc.nth !== undefined && `#${loc.nth}`,
    ]
      .filter(Boolean)
      .join(" ");

  // Elements behind each measurement, so a crop can scroll one into view.
  const refs: Element[] = [];
  (window as unknown as { __layoutConstraintRefs: Element[] }).__layoutConstraintRefs = refs;

  const findings: Finding[] = [];
  for (const c of constraints) {
    for (const scope of resolve(c.scope, [document.body])) {
      const scopeRect = union(scope.map(box))!;
      if (c.scopeMinWidth && scopeRect.right - scopeRect.left < c.scopeMinWidth) continue;
      const measured: { label: string; value: number; rect: R; ref: number }[] = [];
      let stale: string | null = null;
      for (const s of c.subjects) {
        const hits = resolve(s.all ? s.locator : { ...s.locator, nth: s.locator.nth ?? 0 }, scope);
        if (hits.length === 0 && !s.all) {
          stale = `${describe(s.locator)} matched nothing inside ${describe(c.scope)}`;
          break;
        }
        hits.forEach((els, i) => {
          const rect = union(els.map((el) => LEVEL[s.level](el)).filter(nonEmpty));
          if (!rect) return;
          measured.push({
            label: `${describe(s.locator)}${s.all ? ` [${i}]` : ""} ${s.level}.${s.edge}`,
            value: edgeOf(rect, s.edge),
            rect,
            ref: refs.push(els[0]) - 1,
          });
        });
      }
      if (stale) {
        findings.push({
          kind: "stale",
          id: c.id,
          why: c.why,
          detail: stale,
          scopeRect,
          ref: refs.push(scope[0]) - 1,
        });
        continue;
      }
      if (measured.length < 2) continue;
      const values = measured.map((m) => m.value);
      const spread = Math.max(...values) - Math.min(...values);
      if (spread > (c.tolerance ?? 1)) {
        findings.push({ kind: "violation", id: c.id, why: c.why, spread, measured });
      }
    }
  }
  return findings;
}
