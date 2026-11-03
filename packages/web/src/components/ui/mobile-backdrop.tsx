import type { Ref } from "react";
import { cn } from "@/lib/utils";

export interface MobileBackdropProps {
  /** Called when the user taps the backdrop. */
  onDismiss: () => void;
  /**
   * Accessible label for the backdrop button. Should describe what the dismiss
   * does (e.g. "Close sidebar", "Close trace panel").
   */
  label: string;
  /** Tailwind z-index class; defaults to z-30. */
  className?: string;
  /**
   * Whether the panel behind it is open. Passing it keeps the backdrop mounted
   * while closed, invisible and untouchable, so a gesture can fade it in under
   * the finger. Omitted, the caller mounts the backdrop only while open.
   */
  open?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Translucent full-viewport overlay shown only on mobile (`md:hidden`). Used
 * behind slide-out panels (sidebar, drawer) so tapping outside dismisses.
 * Renders as a `<button>` so it's keyboard-focusable and gets the accessible
 * label.
 */
export function MobileBackdrop({ onDismiss, label, className, open, ref }: MobileBackdropProps) {
  const mounted = open !== undefined;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-hidden={mounted && !open ? true : undefined}
      tabIndex={mounted && !open ? -1 : undefined}
      onClick={onDismiss}
      className={cn(
        "fixed inset-0 z-30 bg-overlay md:hidden",
        mounted && "transition-opacity duration-200 ease-out motion-reduce:transition-none",
        mounted && !open && "pointer-events-none opacity-0",
        className,
      )}
    />
  );
}
