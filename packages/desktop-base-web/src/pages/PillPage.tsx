import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { RomeLogo } from "@/components/RomeLogo";
import { romeApi } from "@/lib/rome-api";

// Below this the gesture is a click. A trackpad tap routinely moves a pixel or two.
const DRAG_THRESHOLD_PX = 4;
// Transparent gutter between the icon and the window edge, so the outline,
// which grows past the logo's box, is not clipped by it.
const WINDOW_GUTTER_PX = 4;

const OUTLINE_FILTER_ID = "pill-outline";
// A black mark with a white outline, so it reads on any wallpaper: the black
// on light ones, the outline on dark ones. The logo's inner panel is filled
// with --background, so the page has to say what that is.
const LOGO_STYLE = {
  color: "#111",
  "--background": "#fff",
  filter: `url(#${OUTLINE_FILTER_ID})`,
} as CSSProperties;

interface Gesture {
  x: number;
  y: number;
  dragging: boolean;
}

export function PillPage() {
  const iconRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);

  // The window is sized to the icon, because a transparent window still
  // swallows clicks over its empty area.
  useLayoutEffect(() => {
    const el = iconRef.current;
    if (!el) return;
    romeApi.pill.setSize(
      el.offsetWidth + WINDOW_GUTTER_PX * 2,
      el.offsetHeight + WINDOW_GUTTER_PX * 2,
    );
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    // Ctrl-click is a right-click on macOS and arrives as button 0.
    if (e.button !== 0 || e.ctrlKey) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = { x: e.screenX, y: e.screenY, dragging: false };
    // Where inside the window the pointer went down. The event carries it, so
    // it is right even when the event itself is delivered late.
    romeApi.pill.dragStart(e.clientX, e.clientY);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (!gesture.dragging) {
      // Screen coordinates: client ones stop changing once the window follows
      // the cursor.
      const distance = Math.hypot(e.screenX - gesture.x, e.screenY - gesture.y);
      if (distance < DRAG_THRESHOLD_PX) return;
      gesture.dragging = true;
    }
    romeApi.pill.dragMove();
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    // This window is never focused, and while another app is busy in front the
    // press, the moves and the release can reach it in one burst at the end —
    // or with no moves at all. So the release is measured against the press
    // too; a gesture that ended somewhere else was a drag, whatever came between.
    const travelled = Math.hypot(e.screenX - gesture.x, e.screenY - gesture.y) >= DRAG_THRESHOLD_PX;
    if (gesture.dragging || travelled) romeApi.pill.dragEnd();
    else romeApi.pill.click();
  };

  const onPointerCancel = (): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    if (gesture.dragging) romeApi.pill.dragEnd();
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    gestureRef.current = null;
    romeApi.pill.contextMenu();
  };

  return (
    <div
      ref={iconRef}
      role="button"
      aria-label="Open Rome"
      className="fixed flex cursor-default select-none"
      style={{ left: WINDOW_GUTTER_PX, top: WINDOW_GUTTER_PX }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
    >
      {/* The outline dilates the mark's own shape, so it follows every edge at
          one width. */}
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <filter id={OUTLINE_FILTER_ID} x="-10%" y="-10%" width="120%" height="120%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="3" result="spread" />
          <feFlood floodColor="#fff" />
          <feComposite in2="spread" operator="in" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </svg>
      <RomeLogo className="size-10 overflow-visible" style={LOGO_STYLE} />
    </div>
  );
}
