import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "./cn.js";

type AlertVariant = "default" | "info" | "success" | "warning" | "destructive";

// Every tinted variant re-inks the description: muted-foreground is paired
// against surface, and on the tinted light backgrounds it lands below 4.5:1.
// Neutral ink holds contrast on every tinted bg and keeps the tinted title
// leading. The tone rides `--alert-description-color` rather than a slot
// selector, so the class reading it stays on AlertDescription where a caller's
// own text color still wins the merge.
const tinted = (classes: string) => `${classes} [--alert-description-color:var(--foreground)]`;

const variantClasses: Record<AlertVariant, string> = {
  default: "border-border bg-surface text-foreground [&>svg]:text-muted-foreground",
  info: tinted("border-info-border bg-info-bg text-info-fg [&>svg]:text-info-fg"),
  success: tinted("border-success-border bg-success-bg text-success-fg [&>svg]:text-success-fg"),
  warning: tinted("border-warning-border bg-warning-bg text-warning-fg [&>svg]:text-warning-fg"),
  destructive: tinted(
    "border-destructive-border bg-destructive-bg text-destructive-fg [&>svg]:text-destructive-fg",
  ),
};

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { className, variant = "default", ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      role="alert"
      className={cn(
        // 16px unless the glyph carries a `size-*`, and the icon column is
        // `auto` rather than a fixed 1rem so it tracks whatever the glyph ends
        // up being — a caller opting out of the size would otherwise overflow a
        // column pinned to the default.
        "relative grid w-full grid-cols-[0_1fr] items-start gap-y-1 rounded-8 border px-4 py-3 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-3 [&>svg:not([class*='size-'])]:size-4 [&>svg]:translate-y-0.5",
        variantClasses[variant],
        className,
      )}
      {...rest}
    />
  );
});

// 600 on top of the UI role: both rows share a size and line box, and on a
// tinted variant the same ink, so weight alone marks the headline. 600 rather
// than 500 because a CJK system fallback ships a Bold face and no Medium.
export const AlertTitle = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function AlertTitle({ className, ...rest }, ref) {
    return (
      <div ref={ref} className={cn("col-start-2 text-ui font-semibold", className)} {...rest} />
    );
  },
);

export const AlertDescription = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function AlertDescription({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        data-slot="alert-description"
        className={cn(
          "col-start-2 text-ui text-[color:var(--alert-description-color,var(--muted-foreground))]",
          className,
        )}
        {...rest}
      />
    );
  },
);
