import { useEffect, useRef } from "react";
import { useFileBrowserStore } from "../store/context";

type Callback = (selection: {
  selectedPath: string | null;
  currentFolderPath: string | null;
  selectedTreePaths: string[];
}) => void;

/**
 * Surface selection upward for embedders that mirror selection elsewhere
 * (the workspace ProjectsWidget). The browser is the source of truth; this
 * just fires the prop callback when selection changes. `currentFolderPath` is
 * the folder whose contents the browser is showing. In the compact layout,
 * pane drilling moves `filesPaneDrillPath` without touching the selection (the
 * mirror runs the other way), so the drill path is the fresher signal. In the
 * two-pane layout the pane is unmounted and its drill path goes stale, so the
 * tree's folder selection is the signal.
 */
export function useSelectionChangeBroadcast(compact: boolean, onSelectionChange?: Callback) {
  const selectedPath = useFileBrowserStore((s) => s.selection.selectedPath);
  const selectedFolderPath = useFileBrowserStore((s) => s.selection.selectedFolderPath);
  const filesPaneDrillPath = useFileBrowserStore((s) => s.ui.filesPaneDrillPath);
  const selectedTreePaths = useFileBrowserStore((s) => s.selection.selectedTreePaths);
  const currentFolderPath = (compact ? filesPaneDrillPath : null) ?? selectedFolderPath;
  const callbackRef = useRef(onSelectionChange);
  useEffect(() => {
    callbackRef.current = onSelectionChange;
  }, [onSelectionChange]);
  useEffect(() => {
    callbackRef.current?.({ selectedPath, currentFolderPath, selectedTreePaths });
  }, [selectedPath, currentFolderPath, selectedTreePaths]);
}
