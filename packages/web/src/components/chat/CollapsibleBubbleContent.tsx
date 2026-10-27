import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { HOLD_STICK_EVENT } from "@/hooks/use-stick-to-bottom";
import { findScrollableYAncestor } from "@/lib/scroll-container";
import { scrollTopAfterToggle } from "./scroll-anchor";

function remInPixels(): number {
  return Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
}

/** A message taller than this is cut. About 13 lines of body text. */
const COLLAPSED_MAX_HEIGHT_REM = 20;

/**
 * Content collapses only when it is taller than the cut by this much (about two
 * lines), so the toggle never hides less than it takes to draw.
 */
const MIN_HIDDEN_REM = 3;

// The end bar can sit behind the composer that floats over the bottom of the
// transcript; this much of the scroller's bottom is not counted as visible.
const COMPOSER_ALLOWANCE = "0px 0px -96px 0px";

/**
 * A message's content, cut to {@link COLLAPSED_MAX_HEIGHT_REM} with a fade and a
 * toggle when it is taller. The cut is a plain height limit: it may fall through
 * a line, a code block, or a table, and the fade covers it. Whether the content
 * is tall enough is measured on the content itself, which the cut never clips,
 * and again whenever it or its width changes, since markdown with tables and
 * images settles after its first paint.
 *
 * Only a cut message clips. An open one, and one that needs no cut, has no
 * overflow container, so the sticky copy and download controls of a code block
 * stick to the transcript while it is read.
 *
 * The cut text stays in the page (clipped, not removed), so it can be selected
 * and found with the browser's find. A scroll inside the cut, which is how find
 * reaches a match, opens the content. The open state is local: a message starts
 * cut and keeps its choice until it unmounts.
 *
 * The toggle is one full-width bar under the content, in the same slot whether
 * the message is cut or open: only its label and the revealed text differ, so
 * opening or closing moves nothing above the cut. While the message is open and
 * that bar is off screen and the top of the message has scrolled out of view, a
 * small "Show less" pill floats at the top right of the visible part of the
 * message. With the top in view it would sit over the first line, so it waits. It sits in a zero-height sticky wrapper, so
 * it takes no room and its coming and going moves nothing. It is hidden from
 * assistive technology and the tab order, which keep the bar as the one toggle.
 * Top, not bottom, because the composer floats over the bottom of the
 * transcript at a height that varies.
 *
 * The page must not jump when either is pressed, so the bubble's top is what
 * holds still: the transcript scrolls to put it back where it was, in a layout
 * effect, before paint, and again for two frames because code highlighting and
 * fonts settle late. The exception is a bubble that closes with its top scrolled
 * out of view, which is brought to the top of the transcript (see
 * scrollTopAfterToggle). The transcript's own stick-to-bottom is told to hold
 * meanwhile (see HOLD_STICK_EVENT), so a message at the bottom does not pull the
 * view to the end. The browser's own scroll anchoring is off inside the message:
 * it would add its correction to ours.
 */
export function CollapsibleBubbleContent({ children }: { children: ReactNode }) {
  const { t } = useTranslation("chat");
  const regionId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLButtonElement>(null);
  // The bubble's top before the press that is settling, and the scroller it sits in.
  const held = useRef<{
    bubble: HTMLElement;
    top: number;
    scroller: Element | null;
    viewportTop: number;
    collapsing: boolean;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [collapsible, setCollapsible] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);
  const [barVisible, setBarVisible] = useState(true);
  const [topAbove, setTopAbove] = useState(false);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () =>
      setCollapsible(
        content.scrollHeight > (COLLAPSED_MAX_HEIGHT_REM + MIN_HIDDEN_REM) * remInPixels(),
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const hold = held.current;
    if (!hold) return;
    held.current = null;
    // Scrolls until the bubble's top is back where it belongs on screen.
    const restore = () => {
      const after = hold.bubble.getBoundingClientRect().top;
      const scrollTop = hold.scroller ? hold.scroller.scrollTop : window.scrollY;
      const next = scrollTopAfterToggle({
        scrollTop,
        before: hold.top,
        after,
        viewportTop: hold.viewportTop,
        collapsing: hold.collapsing,
      });
      if (Math.abs(next - scrollTop) < 0.5) return;
      if (hold.scroller) hold.scroller.scrollTop = next;
      else window.scrollTo(0, next);
    };
    restore();
    let later = 0;
    const frame = requestAnimationFrame(() => {
      restore();
      later = requestAnimationFrame(restore);
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(later);
    };
  }, [expanded]);

  // Whether the bar is on screen, and whether the message's top has scrolled
  // above the transcript: together they decide whether the pill floats.
  useEffect(() => {
    const bar = barRef.current;
    const top = topRef.current;
    if (!expanded || !bar || !top || typeof IntersectionObserver === "undefined") return;
    const root = findScrollableYAncestor(bar);
    const watch = (
      target: Element,
      rootMargin: string,
      onEntry: (entry: IntersectionObserverEntry) => void,
    ) => {
      const observer = new IntersectionObserver(([entry]) => onEntry(entry), { root, rootMargin });
      observer.observe(target);
      return observer;
    };
    const observers = [
      watch(bar, COMPOSER_ALLOWANCE, (entry) => setBarVisible(entry.isIntersecting)),
      watch(top, "0px", (entry) =>
        setTopAbove(entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)),
      ),
    ];
    return () => {
      for (const observer of observers) observer.disconnect();
    };
  }, [expanded, collapsible]);

  const press = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.dispatchEvent(new CustomEvent(HOLD_STICK_EVENT, { bubbles: true }));
    const bubble =
      event.currentTarget.closest<HTMLElement>("[data-concierge-bubble]") ?? rootRef.current;
    if (bubble) {
      const scroller = findScrollableYAncestor(event.currentTarget);
      held.current = {
        bubble,
        top: bubble.getBoundingClientRect().top,
        scroller,
        viewportTop: scroller ? scroller.getBoundingClientRect().top : 0,
        collapsing: expanded,
      };
    }
    setExpanded(!expanded);
  };

  const collapsed = collapsible && !expanded;
  const label = expanded ? t("concierge.showLess") : t("concierge.showFullText");
  const icon = expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />;
  return (
    <div ref={rootRef} style={{ overflowAnchor: "none" }}>
      <div ref={topRef} aria-hidden className="h-0" />
      {expanded && collapsible && !barVisible && topAbove ? (
        <div className="sticky top-2 z-10 h-0">
          <div className="absolute top-0 right-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="bg-surface shadow-10"
              aria-hidden
              tabIndex={-1}
              aria-expanded
              aria-controls={regionId}
              onClick={press}
            >
              {label}
              {icon}
            </Button>
          </div>
        </div>
      ) : null}
      <div
        id={regionId}
        className={collapsed ? "relative overflow-hidden" : undefined}
        style={collapsed ? { maxHeight: `${COLLAPSED_MAX_HEIGHT_REM}rem` } : undefined}
        onScroll={(event) => {
          if (collapsed && event.currentTarget.scrollTop > 0) setExpanded(true);
        }}
      >
        <div ref={contentRef}>{children}</div>
        {collapsed ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-muted to-transparent"
          />
        ) : null}
      </div>
      {collapsible ? (
        <div className="mt-2">
          <Button
            ref={barRef}
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={press}
          >
            {label}
            {icon}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
