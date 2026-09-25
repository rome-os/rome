import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export interface HorizontalScrollRailProps {
  children: ReactNode;
  id: string;
}

// Pixels per wheel step in the line delta mode. Chromium reports pixels, and
// Firefox reports lines for a wheel mouse.
const LINE_HEIGHT_PX = 16;

// A wheel mouse reports `deltaY` and no `deltaX`, and Chromium and WebKit do
// not map it onto a horizontal-only scroller, so the wheel scrolls the nearest
// vertical ancestor while the rail, with its scrollbar hidden, offers a mouse
// no other way to reach the clipped cards. This maps a dominant-vertical delta
// onto `scrollLeft` and returns whether the rail consumed the event. A
// trackpad's horizontal swipe, pinch-zoom (`ctrlKey`), and a wheel at either
// end of the rail pass through so the page keeps scrolling.
function scrollRailByWheel(rail: HTMLElement, event: WheelEvent): boolean {
  if (event.ctrlKey) return false;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
  const maxScrollLeft = rail.scrollWidth - rail.clientWidth;
  if (maxScrollLeft <= 0) return false;
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? LINE_HEIGHT_PX
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? rail.clientWidth
        : 1;
  const delta = event.deltaY * unit;
  const atStart = delta < 0 && rail.scrollLeft <= 0;
  const atEnd = delta > 0 && rail.scrollLeft >= maxScrollLeft - 1;
  if (atStart || atEnd) return false;
  rail.scrollLeft = Math.max(0, Math.min(maxScrollLeft, rail.scrollLeft + delta));
  return true;
}

export function HorizontalScrollRail({ children, id }: HorizontalScrollRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const maskImage =
    edges.left && edges.right
      ? "linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%)"
      : edges.left
        ? "linear-gradient(to right, transparent 0, black 24px, black 100%)"
        : edges.right
          ? "linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)"
          : undefined;

  const updateEdges = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScrollLeft = Math.max(rail.scrollWidth - rail.clientWidth, 0);
    const next = {
      left: rail.scrollLeft > 1,
      right: rail.scrollLeft < maxScrollLeft - 1,
    };
    setEdges((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const frame = window.requestAnimationFrame(updateEdges);
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateEdges);
    resizeObserver?.observe(rail);
    window.addEventListener("resize", updateEdges);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateEdges);
    };
  }, [children, updateEdges]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    // React registers `onWheel` as a passive listener, which cannot cancel the
    // page scroll, so the rail attaches its own non-passive one.
    const onWheel = (event: WheelEvent) => {
      if (scrollRailByWheel(rail, event)) event.preventDefault();
    };
    rail.addEventListener("wheel", onWheel, { passive: false });
    return () => rail.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="relative overflow-visible">
      <div
        ref={railRef}
        onScroll={updateEdges}
        className="-mx-2 flex gap-3 overflow-x-auto overscroll-x-contain px-2 py-1 pb-3 [mask-image:var(--scroll-fade-mask)] [-webkit-mask-image:var(--scroll-fade-mask)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-horizontal-scroll={id}
        data-scroll-left={edges.left}
        data-scroll-right={edges.right}
        role="list"
        style={{ "--scroll-fade-mask": maskImage } as CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}
