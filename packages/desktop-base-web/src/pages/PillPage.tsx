import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { RomeLogo } from "@/components/RomeLogo";
import { romeApi } from "@/lib/rome-api";

// Below this the gesture is a click. A trackpad tap routinely moves a pixel or two.
const DRAG_THRESHOLD_PX = 4;
// Transparent gutter between the icon and the window edge, so no border is
// clipped by it.
const WINDOW_GUTTER_PX = 4;

// A white disc, so the black mark reads on any wallpaper. The logo's inner
// panel is filled with --background, so the disc has to say what that is.
const LOGO_DISC_STYLE = {
  background: "#fff",
  color: "#111",
  "--background": "#fff",
  border: "1px solid rgba(0, 0, 0, 0.15)",
} as CSSProperties;

interface Gesture {
  x: number;
  y: number;
  dragging: boolean;
}

export function PillPage() {
  const [name, setName] = useState("Rome");
  const iconRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);

  useEffect(() => {
    const off = romeApi.on("pill:name", (next) => setName(next));
    romeApi.pill.ready();
    return off;
  }, []);

  // The window is sized to the icon and its name, because a transparent window
  // still swallows clicks over its empty area.
  useLayoutEffect(() => {
    const el = iconRef.current;
    if (!el) return;
    romeApi.pill.setSize(
      el.offsetWidth + WINDOW_GUTTER_PX * 2,
      el.offsetHeight + WINDOW_GUTTER_PX * 2,
    );
  }, [name]);

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
      aria-label={`Open ${name}`}
      className="fixed flex w-max cursor-default select-none flex-col items-center gap-1"
      style={{ left: WINDOW_GUTTER_PX, top: WINDOW_GUTTER_PX }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
    >
      <span
        className="flex size-12 shrink-0 items-center justify-center rounded-full"
        style={LOGO_DISC_STYLE}
      >
        <RomeLogo className="size-7" />
      </span>
      {/* Dark in either appearance: the name sits on the user's wallpaper, not on
          a Rome surface, so the theme's own background says nothing about what
          is behind it. */}
      <span className="dark flex h-5 max-w-40 items-center rounded-full border border-border bg-card px-2 text-xs font-medium text-card-foreground">
        <span className="truncate">{name}</span>
      </span>
    </div>
  );
}
