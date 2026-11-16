import { isImeCompositionEvent } from "@rome-os/ui/keyboard-submit";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

export interface RenameInPlace {
  /** The id of the item being renamed, or null. */
  editingId: string | null;
  /**
   * Opens the field for `id` once the menu that offered Rename has closed, so
   * the menu's focus restore cannot blur the field and commit it early.
   */
  start: (id: string, currentName: string) => void;
  /** Spread on the field. It takes focus with its text selected. */
  inputProps: {
    ref: (element: HTMLInputElement | null) => void;
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onBlur: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  };
  /** Spread on the Radix menu content that holds the Rename item. */
  menuContentProps: {
    onCloseAutoFocus: (event: Event) => void;
  };
}

/**
 * Edit a name in place. Enter or leaving the field commits, Escape cancels. An
 * empty or unchanged name cancels without calling `onCommit`, which receives
 * the trimmed name.
 */
export function useRenameInPlace({
  onCommit,
}: {
  onCommit: (id: string, name: string) => void;
}): RenameInPlace {
  const [editing, setEditingState] = useState<{ id: string; original: string } | null>(null);
  // Mirrors `editing` so a blur that follows Enter, as the field unmounts,
  // finds the edit already closed and commits nothing twice.
  const editingRef = useRef(editing);
  const setEditing = useCallback((next: { id: string; original: string } | null) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);
  const [value, setValue] = useState("");
  const startingRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const start = useCallback(
    (id: string, currentName: string) => {
      startingRef.current = true;
      setValue(currentName);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setEditing({ id, original: currentName });
      }, 0);
    },
    [setEditing],
  );

  const cancel = () => {
    setEditing(null);
    setValue("");
  };

  const commit = () => {
    const current = editingRef.current;
    if (!current) return;
    const name = value.trim();
    cancel();
    if (name.length === 0 || name === current.original) return;
    onCommit(current.id, name);
  };

  // A callback ref focuses the field the moment it mounts.
  const ref = useCallback((element: HTMLInputElement | null) => {
    if (!element) return;
    element.focus();
    element.select();
  }, []);

  return {
    editingId: editing?.id ?? null,
    start,
    inputProps: {
      ref,
      value,
      onChange: (event) => setValue(event.target.value),
      onBlur: commit,
      onKeyDown: (event) => {
        if (isImeCompositionEvent(event)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      },
    },
    menuContentProps: {
      onCloseAutoFocus: (event) => {
        // Radix returns focus to the menu's trigger as it closes. The trigger
        // is hidden or gone once the row shows the field, so that focus lands
        // on the page and blurs the field. Only Rename skips the restore.
        if (!startingRef.current) return;
        startingRef.current = false;
        event.preventDefault();
      },
    },
  };
}
