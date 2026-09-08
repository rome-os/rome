import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Geo {
  // from anchor (top-center of the source card), viewport coords
  fx: number;
  fy: number;
  // target button rect, viewport coords
  tx: number;
  ty: number;
  tw: number;
  th: number;
}

const STROKE = "var(--primary, #e0682f)";

/** Locate the chat toolbar's "Add widget" (+) trigger in the HOST document. The
 *  inline component's JS runs in the host window, so it can reach outside its
 *  own shadow root. Returns null on surfaces without the toolbar (e.g. mobile),
 *  where the pointer simply doesn't draw. */
export function findAddWidgetButton(): HTMLElement | null {
  // 1. By the stable coach hook the host stamps on the real (+) button. Precise
  //    and locale-independent — preferred over the heuristics below.
  const tagged = document.querySelector<HTMLElement>('[data-coach="add-widget"]');
  if (tagged) return tagged;
  // 2. By accessible name (English: "Add widget"). Only matches the English UI.
  const labelled =
    document.querySelector<HTMLElement>('button[aria-label="Add widget"]') ??
    document.querySelector<HTMLElement>('button[title="Add widget"]') ??
    Array.from(
      document.querySelectorAll<HTMLButtonElement>("button[aria-label], button[title]"),
    ).find((b) => /widget/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || ""));
  if (labelled) return labelled;
  // 3. Cross-language fallback: the only popup-trigger button bearing a plus
  //    glyph (the widget picker's "+"). Other popup triggers use different
  //    icons, so scoping to a plus icon inside a popup trigger is precise. The
  //    picker is a combobox, so its trigger announces `dialog`; other triggers
  //    on the toolbar are menus.
  for (const b of Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button[aria-haspopup="dialog"], button[aria-haspopup="menu"]',
    ),
  )) {
    if (b.querySelector("svg.lucide-plus")) return b;
  }
  return null;
}

/** The coach target: while the widget picker is open, point at its "Browser" row
 *  (found by its Chrome icon, so it works cross-language); otherwise point at the
 *  "Add widget" (+) trigger. The picker is a combobox — a listbox inside a
 *  popover — so its rows are options; `menu`/`menuitem` stay in the selectors
 *  because other Rome surfaces still open the same coach on a dropdown. */
const WIDGET_ROW = '[role="option"], [role="menuitem"]';

export function findWidgetCoachTarget(): HTMLElement | null {
  const popup = document.querySelector(
    '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
  );
  if (popup) {
    const item =
      popup.querySelector<HTMLElement>('[data-coach="widget-browser"]') ??
      popup.querySelector<HTMLElement>("svg.lucide-chrome")?.closest<HTMLElement>(WIDGET_ROW) ??
      Array.from(popup.querySelectorAll<HTMLElement>(WIDGET_ROW)).find((el) =>
        /browser|desktop/i.test(el.textContent || ""),
      );
    if (item) return item;
  }
  return findAddWidgetButton();
}

/**
 * Draws an attention pointer from `fromRef` (a card the guardian is reading) up
 * to a host element (`findTarget`), with a dashed connector, an arrowhead, and a
 * pulsing ring on the target. Rendered into document.body (outside the app's
 * shadow root) so nothing clips it, and re-measured each frame so it tracks
 * scrolling and the live-rendering chat. Draws nothing once `active` is false or
 * the target can't be found.
 */
export function CoachPointer({
  fromRef,
  findTarget,
  active = true,
  stop,
}: {
  fromRef: React.RefObject<HTMLElement | null>;
  findTarget: () => HTMLElement | null;
  active?: boolean;
  /** Checked each frame — once it returns true (e.g. the browser is now open),
   *  the pointer stops drawing. Reactive: it reappears if it flips back. */
  stop?: () => boolean;
}) {
  const [geo, setGeo] = useState<Geo | null>(null);
  const last = useRef<Geo | null>(null);

  useEffect(() => {
    if (!active) {
      setGeo(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      const t = stop && stop() ? null : findTarget();
      const f = fromRef.current;
      const tr = t?.getBoundingClientRect();
      // A matched-but-unlaid-out target (e.g. the `hidden md:inline-flex` (+)
      // button below the md breakpoint) reports a 0×0 rect at 0,0 — never point
      // there. Treat a collapsed rect as "no target" so the pointer hides.
      if (t && f && tr && tr.width > 0 && tr.height > 0) {
        const fr = f.getBoundingClientRect();
        const next: Geo = {
          fx: fr.left + fr.width / 2,
          fy: fr.top,
          tx: tr.left,
          ty: tr.top,
          tw: tr.width,
          th: tr.height,
        };
        const prev = last.current;
        const changed =
          !prev ||
          Math.abs(prev.fx - next.fx) > 1 ||
          Math.abs(prev.fy - next.fy) > 1 ||
          Math.abs(prev.tx - next.tx) > 1 ||
          Math.abs(prev.ty - next.ty) > 1;
        if (changed) {
          last.current = next;
          setGeo(next);
        }
      } else if (last.current) {
        last.current = null;
        setGeo(null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, fromRef, findTarget, stop]);

  if (!active || !geo) return null;

  // Anchor at the button's bottom-center; curve down to the card's top-center.
  const ax = geo.tx + geo.tw / 2;
  const ay = geo.ty + geo.th;
  const midY = (geo.fy + ay) / 2;

  return createPortal(
    <svg
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: 2147483000,
        overflow: "visible",
      }}
    >
      <rect
        x={geo.tx - 5}
        y={geo.ty - 5}
        width={geo.tw + 10}
        height={geo.th + 10}
        rx={9}
        fill="none"
        stroke={STROKE}
        strokeWidth={2}
        style={{ animation: "wtr-coach-pulse 1.4s ease-in-out infinite" }}
      />
      <path
        d={`M ${geo.fx} ${geo.fy} C ${geo.fx} ${midY}, ${ax} ${midY}, ${ax} ${ay + 9}`}
        fill="none"
        stroke={STROKE}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray="5 4"
        style={{ animation: "wtr-coach-dash 0.6s linear infinite" }}
      />
      <path d={`M ${ax} ${ay} L ${ax - 5} ${ay + 9} L ${ax + 5} ${ay + 9} Z`} fill={STROKE} />
      <style>{`
        @keyframes wtr-coach-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
        @keyframes wtr-coach-dash { to { stroke-dashoffset: -9 } }
      `}</style>
    </svg>,
    document.body,
  );
}
