import {
  useRef,
  type TouchEvent,
  type TouchEventHandler,
  type WheelEvent,
  type WheelEventHandler,
} from "react";

// Radix Dialog locks page scroll with react-remove-scroll. The lock wraps the
// *overlay* and registers the dialog content as a "shard", then listens for
// wheel/touchmove on `document`: an event whose `event.target` is inside a
// shard may scroll, every other event is cancelled. Rome apps mount inside a
// shadow root, and at `document` an event from a shadow tree is retargeted to
// the shadow host. The host is never inside the shard, so the lock cancels
// every wheel and touch scroll in the dialog and its content cannot scroll.
//
// The fix lets an event through only when an element between the event target
// and the dialog content can still scroll in the event's direction: it stops
// the event before it reaches `document`, so the browser scrolls that element.
// When nothing inside can scroll (short content, or a list already at its
// end), the event continues to `document` and the lock cancels it as usual,
// so the page behind the dialog never scrolls. Outside a shadow root the
// handlers do nothing — the lock already works there.

type ScrollHandlers<T extends Element> = {
  onWheel?: WheelEventHandler<T>;
  onTouchStart?: TouchEventHandler<T>;
  onTouchMove?: TouchEventHandler<T>;
};

function inShadowRoot(node: Node): boolean {
  return typeof ShadowRoot !== "undefined" && node.getRootNode() instanceof ShadowRoot;
}

function canScroll(axis: "x" | "y", node: Element, delta: number): boolean {
  const style = window.getComputedStyle(node);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") return false;
  if (axis === "y") {
    const max = node.scrollHeight - node.clientHeight;
    return delta > 0 ? node.scrollTop < max - 0.5 : node.scrollTop > 0.5;
  }
  const max = node.scrollWidth - node.clientWidth;
  // In RTL, scrollLeft runs from 0 (start, right edge) to -max.
  const position = style.direction === "rtl" ? -node.scrollLeft : node.scrollLeft;
  const forward = style.direction === "rtl" ? -delta : delta;
  return forward > 0 ? position < max - 0.5 : position > 0.5;
}

/** Whether any element from `target` up to `boundary` can scroll by this delta. */
function canScrollWithin(
  target: EventTarget | null,
  boundary: Element,
  deltaX: number,
  deltaY: number,
): boolean {
  const axis = Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
  const delta = axis === "x" ? deltaX : deltaY;
  if (delta === 0) return false;
  let node = target instanceof Element ? target : null;
  while (node) {
    if (canScroll(axis, node, delta)) return true;
    if (node === boundary) return false;
    node = node.parentElement;
  }
  return false;
}

/**
 * Wheel/touch handlers for a Radix Dialog content element that keep its
 * scroll areas working inside a shadow root. Pass the caller's own handlers to
 * compose them.
 */
export function useShadowRootScroll<T extends Element>(handlers: ScrollHandlers<T> = {}) {
  const lastTouch = useRef<{ x: number; y: number } | null>(null);
  return {
    onWheel(event: WheelEvent<T>) {
      handlers.onWheel?.(event);
      const content = event.currentTarget;
      if (
        inShadowRoot(content) &&
        canScrollWithin(event.target, content, event.deltaX, event.deltaY)
      ) {
        event.stopPropagation();
      }
    },
    onTouchStart(event: TouchEvent<T>) {
      handlers.onTouchStart?.(event);
      const touch = event.touches[0];
      lastTouch.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchMove(event: TouchEvent<T>) {
      handlers.onTouchMove?.(event);
      const touch = event.touches[0];
      const last = lastTouch.current;
      if (!touch || event.touches.length > 1) return;
      lastTouch.current = { x: touch.clientX, y: touch.clientY };
      if (!last) return;
      const content = event.currentTarget;
      // A finger moving up scrolls content down, like a positive wheel delta.
      const deltaX = last.x - touch.clientX;
      const deltaY = last.y - touch.clientY;
      if (inShadowRoot(content) && canScrollWithin(event.target, content, deltaX, deltaY)) {
        event.stopPropagation();
      }
    },
  };
}
