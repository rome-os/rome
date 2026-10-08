import { type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "./cn.js";
import { AutoPortal } from "./portal.js";
import { useShadowRootScroll } from "./shadow-scroll.js";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the panel when no visible title is rendered. */
  ariaLabel?: string;
  /** Tailwind width utility for the panel (defaults to a wide store panel). */
  widthClassName?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Right-side slide-in panel. A Radix Dialog under the hood (focus trap, ESC,
 * scrim) styled to cover most of the viewport from the right edge.
 */
export function Sheet({
  open,
  onClose,
  ariaLabel,
  widthClassName = "w-full max-w-5xl",
  className,
  children,
}: SheetProps) {
  const scrollHandlers = useShadowRootScroll<HTMLDivElement>();
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <AutoPortal portal={DialogPrimitive.Portal}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          aria-label={ariaLabel}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex flex-col border-l border-border bg-surface text-foreground shadow-25 outline-none",
            "duration-200 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
            widthClassName,
            className,
          )}
          {...scrollHandlers}
        >
          {children}
        </DialogPrimitive.Content>
      </AutoPortal>
    </DialogPrimitive.Root>
  );
}

export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;
