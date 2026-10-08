import { useEffect, useState } from "react";

// Radix Dialog locks page scroll with react-remove-scroll. The lock wraps the
// *overlay* and registers the dialog content as a "shard", then listens for
// wheel/touchmove on `document`: an event whose `event.target` is inside a
// shard may scroll, every other event is cancelled. Rome apps mount inside a
// shadow root, and at `document` an event from a shadow tree is retargeted to
// the shadow host. The host is never inside the shard, so the lock cancels
// every wheel and touch scroll in the dialog and its content cannot scroll.
//
// The fix listens on the content's shadow root, where the target is still the
// real element. It lets an event through only when the target is a DOM
// descendant of the content and an element between the two can still scroll
// in the event's direction: it stops the event at the shadow root, so the
// browser scrolls that element. Every other event continues to `document` and
// the lock cancels it as usual, so the page behind never scrolls.
//
// Why a native listener on the shadow root, not a React handler on the content:
// - React handlers also receive events from layers portalled out of the
//   dialog (a non-modal Popover, a combobox list). Their targets are outside
//   the content, so a walk from them could reach app elements behind the
//   dialog. DOM containment excludes them.
// - The shadow root is above the React root and portal containers, so React
//   has already dispatched the event to every handler, including handlers on
//   the dialog's React ancestors, before it is stopped.
// Outside a shadow root nothing is attached — the lock already works there.

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
 * Callback ref for a Radix Dialog content element that keeps its scroll areas
 * working inside a shadow root.
 */
export function useShadowRootScroll(): (node: HTMLElement | null) => void {
  const [content, setContent] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!content || typeof ShadowRoot === "undefined") return;
    const root = content.getRootNode();
    if (!(root instanceof ShadowRoot)) return;

    const letThrough = (event: Event, deltaX: number, deltaY: number) => {
      const target = event.target;
      if (!(target instanceof Node) || !content.contains(target)) return;
      if (canScrollWithin(target, content, deltaX, deltaY)) event.stopPropagation();
    };
    const onWheel = (event: WheelEvent) => letThrough(event, event.deltaX, event.deltaY);
    let lastTouch: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      lastTouch = touch ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      const last = lastTouch;
      if (!touch || event.touches.length > 1) return;
      lastTouch = { x: touch.clientX, y: touch.clientY };
      if (!last) return;
      // A finger moving up scrolls content down, like a positive wheel delta.
      letThrough(event, last.x - touch.clientX, last.y - touch.clientY);
    };

    const options: AddEventListenerOptions = { passive: true };
    root.addEventListener("wheel", onWheel as EventListener, options);
    root.addEventListener("touchstart", onTouchStart as EventListener, options);
    root.addEventListener("touchmove", onTouchMove as EventListener, options);
    return () => {
      root.removeEventListener("wheel", onWheel as EventListener);
      root.removeEventListener("touchstart", onTouchStart as EventListener);
      root.removeEventListener("touchmove", onTouchMove as EventListener);
    };
  }, [content]);
  return setContent;
}
