import { useRef } from "react";
import type { DragEvent } from "react";
import { dataTransferHasFiles } from "@/lib/clipboard-files";

export interface FileDropArea {
  /** Spread on the element files are dropped on. */
  dropAreaProps: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDropCapture: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
}

/**
 * An area that takes files dragged in from outside the page. Drags of anything
 * else pass through untouched.
 *
 * `onActiveChange` reports true while files are over the area, including over
 * its children, and false once they leave or drop. A child that handles its own
 * drop and stops propagation still ends the drag here.
 *
 * While `refuse` returns true, the area shows a no-drop cursor, stays inactive
 * and drops nothing. It is read on every drag event.
 */
export function useFileDropArea({
  onActiveChange,
  onDrop,
  refuse,
}: {
  onActiveChange: (active: boolean) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  refuse?: () => boolean;
}): FileDropArea {
  // dragenter and dragleave fire for every child the pointer crosses, so the
  // area is active while more enters than leaves have arrived.
  const depthRef = useRef(0);
  const activeRef = useRef(false);

  const setActive = (active: boolean) => {
    if (activeRef.current === active) return;
    activeRef.current = active;
    onActiveChange(active);
  };

  const refused = (event: DragEvent<HTMLElement>) => {
    if (!refuse?.()) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
    return true;
  };

  return {
    dropAreaProps: {
      onDragEnter: (event) => {
        if (!dataTransferHasFiles(event.dataTransfer) || refused(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        depthRef.current += 1;
        setActive(true);
      },
      onDragOver: (event) => {
        if (!dataTransferHasFiles(event.dataTransfer) || refused(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setActive(true);
      },
      onDragLeave: (event) => {
        if (!dataTransferHasFiles(event.dataTransfer)) return;
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setActive(false);
      },
      onDropCapture: (event) => {
        if (!dataTransferHasFiles(event.dataTransfer)) return;
        depthRef.current = 0;
        setActive(false);
      },
      onDrop: (event) => {
        if (!dataTransferHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (refuse?.()) return;
        onDrop(event);
      },
    },
  };
}
