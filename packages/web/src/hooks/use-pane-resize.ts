import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

/** How far one arrow key press moves the edge, in pixels. */
export const PANE_RESIZE_KEY_STEP = 24;

export interface PaneResize {
  /** True while the pointer drags the edge. */
  resizing: boolean;
  /** Spread on the edge element. It is a focusable vertical separator. */
  separatorProps: {
    role: "separator";
    tabIndex: 0;
    "aria-orientation": "vertical";
    "aria-valuemin": number;
    "aria-valuemax": number;
    "aria-valuenow": number;
    "data-resizing": true | undefined;
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
  };
}

/**
 * Resize a pane by dragging the edge on its right, or with the arrow keys
 * while the edge has focus. Home and a double click reset it.
 *
 * Sizes are in pixels and clamped to `min`..`max`. `onResize` fires on every
 * change. `onResizeEnd` fires once a drag ends and after each key press, which
 * is the moment to save the size.
 */
export function usePaneResize({
  size,
  min,
  max,
  onResize,
  onResizeEnd,
  onReset,
}: {
  size: number;
  min: number;
  max: number;
  onResize: (size: number) => void;
  onResizeEnd?: (size: number) => void;
  onReset: () => void;
}): PaneResize {
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startSize: number; startX: number; size: number } | null>(null);
  const clamp = (value: number) => Math.max(min, Math.min(max, value));

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setResizing(false);
    if (drag) onResizeEnd?.(drag.size);
  };

  return {
    resizing,
    separatorProps: {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical",
      "aria-valuemin": Math.round(min),
      "aria-valuemax": Math.round(max),
      "aria-valuenow": Math.round(size),
      "data-resizing": resizing || undefined,
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // Capture keeps the drag on the edge while the pointer crosses
        // iframes and other panes.
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { startSize: size, startX: event.clientX, size };
        setResizing(true);
      },
      onPointerMove: (event) => {
        const drag = dragRef.current;
        if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        drag.size = clamp(drag.startSize + event.clientX - drag.startX);
        onResize(drag.size);
      },
      onPointerUp: (event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        endDrag();
      },
      onLostPointerCapture: endDrag,
      onKeyDown: (event) => {
        if (event.key === "Home") {
          event.preventDefault();
          onReset();
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = clamp(
          size + (event.key === "ArrowLeft" ? -PANE_RESIZE_KEY_STEP : PANE_RESIZE_KEY_STEP),
        );
        onResize(next);
        onResizeEnd?.(next);
      },
      onDoubleClick: onReset,
    },
  };
}
