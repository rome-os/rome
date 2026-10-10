import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// One pill language for the pre-send chip row. Every chip shares this geometry
// — height, radius, padding, text size — so the row reads as one system. Kind
// is told apart by the icon and an optional muted prefix.

export interface ComposerChipProps extends Omit<ComponentPropsWithoutRef<"span">, "prefix"> {
  icon?: ReactNode;
  // Muted role word in front of the value, e.g. "Agent" / "Skill".
  prefix?: ReactNode;
  // Render the value in the mono stack (skill names, ids).
  mono?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
}

// Geometry shared by the chip's remove button and the upload ring: one 20px
// box in the same trailing position.
const TRAILING_SLOT = "relative -mr-1 ml-1 shrink-0 rounded-full p-1";

export function UploadRing({
  progress,
  label,
  className,
}: {
  progress: number | null;
  label?: string;
  className?: string;
}) {
  // r=5 in a 12px box matches the X icon's size-3 footprint.
  const RADIUS = 5;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const indeterminate = progress === null;
  const fraction = indeterminate ? 0.25 : Math.max(0, Math.min(1, progress));
  return (
    <span
      className={cn(TRAILING_SLOT, "opacity-80", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(fraction * 100)}
    >
      <svg
        viewBox="0 0 12 12"
        className={cn("size-3 -rotate-90", indeterminate && "animate-spin")}
        aria-hidden
      >
        <circle
          cx="6"
          cy="6"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="opacity-25"
        />
        <circle
          cx="6"
          cy="6"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
          className={indeterminate ? undefined : "transition-[stroke-dashoffset]"}
        />
      </svg>
    </span>
  );
}

export const ComposerChip = forwardRef<HTMLSpanElement, ComposerChipProps>(function ComposerChip(
  { icon, prefix, children, mono, onRemove, removeLabel, className, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex h-6 max-w-[14rem] shrink-0 items-center gap-2 rounded-8 border border-border bg-surface px-2 text-badge text-foreground",
        className,
      )}
      {...rest}
    >
      {icon}
      <span className={cn("min-w-0 truncate", mono && "font-mono")}>
        {prefix != null && <span className="font-sans opacity-70">{prefix} </span>}
        {children}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          // The visible box stays 20px so the chip's own height does not move.
          // The pointer target reaches past it through `after:-inset-*`, which
          // is how a Selection control clears the floor without growing its
          // row (docs/ui/component-roles.md, and `Switch` in the kit). Raising
          // the chip to a control step instead is the negative example there.
          className={cn(
            TRAILING_SLOT,
            "opacity-60 transition after:absolute after:-inset-1.5 hover:bg-foreground/10 hover:opacity-100",
          )}
        >
          <X className="size-3" strokeWidth={2.5} />
        </button>
      )}
    </span>
  );
});
