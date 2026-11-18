import { useCallback, useEffect, useRef, useState } from "react";

/** How long a copy control shows that it copied. */
export const COPIED_FEEDBACK_MS = 1500;

/**
 * Copy text, then show "copied" for a moment. A second copy restarts the
 * moment, and `copiedText` names what was copied last, so a list of copy
 * controls marks only the one pressed.
 */
export function useCopyFeedback(): {
  /** The text last copied while its moment lasts, or null. */
  copiedText: string | null;
  /** Resolves false, and shows nothing, when the clipboard refuses the write. Never rejects. */
  copy: (text: string) => Promise<boolean>;
  /** Ends the moment now. */
  reset: () => void;
} {
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const reset = useCallback(() => {
    clearTimer();
    setCopiedText(null);
  }, [clearTimer]);

  const copy = useCallback(
    async (text: string) => {
      try {
        // Undefined outside a secure context.
        if (!navigator.clipboard) return false;
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      clearTimer();
      setCopiedText(text);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setCopiedText(null);
      }, COPIED_FEEDBACK_MS);
      return true;
    },
    [clearTimer],
  );

  return { copiedText, copy, reset };
}
