import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AppGroupedPickerMenuHandle } from "./AppGroupedPickerMenu";

/** A trigger token under the cursor: `start` is the trigger character's index. */
export interface PickerToken {
  start: number;
  query: string;
}

/** Finds the token a trigger opens, or null when the cursor is not in one. */
export type FindPickerToken = (value: string, cursor: number) => PickerToken | null;

/**
 * An `@agent` mention: `@` at the start or after whitespace, then no
 * whitespace up to the cursor.
 */
export const findMentionToken: FindPickerToken = (value, cursor) => {
  for (let i = cursor - 1; i >= 0 && !/\s/.test(value[i]); i--) {
    if (value[i] !== "@") continue;
    if (i === 0 || /\s/.test(value[i - 1])) return { start: i, query: value.slice(i + 1, cursor) };
    return null;
  }
  return null;
};

/**
 * A `/skill` command: `/` as the first character, then no whitespace up to the
 * cursor. A scoped app id (`/@scope/app`) allows one more slash, so a file path
 * is never a query.
 */
export const findSkillToken: FindPickerToken = (value, cursor) => {
  if (!value.startsWith("/") || cursor < 1) return null;
  const query = value.slice(1, cursor);
  if (/\s/.test(query)) return null;
  const slashes = query.split("/").length - 1;
  if (slashes === 0 || (query.startsWith("@") && slashes === 1)) return { start: 0, query };
  return null;
};

/**
 * A trigger token in a textarea opens a picker menu that the keyboard drives
 * while focus stays in the textarea. Accepting an item is the caller's: it
 * turns the token into a chip.
 */
export function useTokenPicker({
  findToken,
  enabled = true,
  acceptOnTab = false,
}: {
  findToken: FindPickerToken;
  /** While false, the picker stays closed. */
  enabled?: boolean;
  /** Tab accepts the selected item, as Enter does. */
  acceptOnTab?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<PickerToken | null>(null);
  const menuRef = useRef<AppGroupedPickerMenuHandle>(null);

  const close = useCallback(() => {
    setOpen(false);
    setToken(null);
  }, []);

  /** Call after every change of the value or the cursor. */
  const update = useCallback(
    (value: string, cursor: number) => {
      const found = enabled ? findToken(value, cursor) : null;
      if (found) {
        setToken(found);
        setOpen(true);
      } else if (open) {
        close();
      }
    },
    [enabled, findToken, open, close],
  );

  /** For the menu's own open changes, such as a click outside. */
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (next) setOpen(true);
      else close();
    },
    [close],
  );

  /** Returns true when the picker handled the key, so the caller stops. */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    const menu = menuRef.current;
    // Every arrow belongs to the menu. Left and right switch between its apps
    // and items panels, so the cursor never slides off the token and closes it.
    const move = ARROW_MOVES[e.key];
    if (move) {
      e.preventDefault();
      if (move.axis === "vertical") menu?.move(move.delta);
      else menu?.moveHorizontal(move.delta);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || (acceptOnTab && e.key === "Tab")) {
      if (menu?.acceptSelected()) {
        e.preventDefault();
        return true;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return true;
    }
    return false;
  };

  return {
    open,
    query: token?.query ?? "",
    token,
    menuRef,
    update,
    close,
    onOpenChange,
    handleKeyDown,
  };
}

const ARROW_MOVES: Record<string, { axis: "vertical" | "horizontal"; delta: 1 | -1 }> = {
  ArrowDown: { axis: "vertical", delta: 1 },
  ArrowUp: { axis: "vertical", delta: -1 },
  ArrowRight: { axis: "horizontal", delta: 1 },
  ArrowLeft: { axis: "horizontal", delta: -1 },
};
