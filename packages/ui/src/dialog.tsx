import { forwardRef, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "./cn.js";
import { IconButton } from "./icon-button.js";
import { AutoPortal } from "./portal.js";

type DialogSize = "sm" | "md" | "lg";

const sizeClasses: Record<DialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export interface DialogProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose: () => void;
  /** Label for the dialog's accessible name. Required when no DialogTitle is rendered. */
  ariaLabel?: string;
  /** When true, ESC + backdrop click are disabled. Used for destructive flows. */
  modal?: boolean;
  size?: DialogSize;
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  ariaLabel,
  modal = false,
  size = "md",
  initialFocusRef,
  children,
  className,
  ...rest
}: DialogProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <AutoPortal portal={DialogPrimitive.Portal}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/35 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-label={ariaLabel}
          onEscapeKeyDown={(event) => {
            if (modal) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (modal) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            if (initialFocusRef) {
              event.preventDefault();
              initialFocusRef.current?.focus();
            }
          }}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2 rounded-16 border border-border bg-surface text-foreground shadow-25 ring-1 ring-black/5",
            sizeClasses[size],
            className,
          )}
          {...rest}
        >
          {children}
        </DialogPrimitive.Content>
      </AutoPortal>
    </DialogPrimitive.Root>
  );
}

export interface DialogHeaderProps extends HTMLAttributes<HTMLDivElement> {
  onClose?: () => void;
  closeLabel?: string;
}

export function DialogHeader({
  onClose,
  closeLabel = "Close",
  className,
  children,
  ...rest
}: DialogHeaderProps) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex items-center justify-between px-6 pt-6 pb-4", className)}
      {...rest}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      {onClose && (
        <IconButton
          label={closeLabel}
          size="sm"
          onClick={onClose}
          icon={
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          }
        />
      )}
    </div>
  );
}

/**
 * Never inject an `id` here. Radix hands the title the same id it puts in the
 * content's `aria-labelledby`; overriding it leaves that reference pointing at
 * nothing, so the dialog has no accessible name (and Radix logs a "requires a
 * DialogTitle" error on every open, since it looks the id up by document).
 */
export const DialogTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function DialogTitle({ className, ...rest }, ref) {
    return (
      <DialogPrimitive.Title
        ref={ref}
        className={cn("text-title text-foreground", className)}
        {...rest}
      />
    );
  },
);

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(function DialogDescription({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("text-ui text-muted-foreground", className)}
      {...rest}
    />
  );
});

// No rule divides the sections; padding alone spaces the column. A body after
// a header drops its top padding so the header's bottom padding is the whole
// gap; a body with no visible header above it, as when the title is
// `sr-only`, keeps both. The footer's gap above is wider than the header's gap
// below, in place of a rule.
export function DialogBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "max-h-[70vh] overflow-y-auto px-6 py-4 [[data-slot=dialog-header]+&]:pt-0",
        className,
      )}
      {...rest}
    />
  );
}

export function DialogFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-end gap-2 px-6 pt-2 pb-6", className)}
      {...rest}
    />
  );
}
