import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// One pill language for the pre-send chip row (Option A: color encodes *state*,
// not kind). Every chip shares this geometry — height, radius, padding, text
// size — so the row reads as one system. Kind is told apart by the icon and an
// optional muted prefix; only the live `active` chip carries the primary accent.
export type ComposerChipTone = "active" | "neutral";

const TONE: Record<ComposerChipTone, string> = {
  active: "border-primary/30 bg-primary/10 text-primary",
  neutral: "border-border bg-surface text-foreground",
};

export interface ComposerChipProps extends Omit<ComponentPropsWithoutRef<"span">, "prefix"> {
  icon?: ReactNode;
  // Muted role word in front of the value, e.g. "Agent" / "Skill".
  prefix?: ReactNode;
  tone?: ComposerChipTone;
  // Render the value in the mono stack (skill names, ids).
  mono?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
  /**
   * Upload progress for this chip's file: a 0–1 fraction, `null` for
   * indeterminate, omitted when nothing is uploading. The ring takes the
   * remove button's slot rather than adding one, so a chip is the same size
   * whether it is idle or uploading and the row never reflows.
   */
  progress?: number | null;
  progressLabel?: string;
}

// Geometry shared by the remove button and the progress ring. Both are a 20px
// box in the same position, which is what keeps the chip from resizing when one
// swaps for the other.
const TRAILING_SLOT = "relative -mr-1 ml-1 shrink-0 rounded-full p-1";

function UploadRing({ progress, label }: { progress: number | null; label?: string }) {
  // r=5 in a 12px box matches the X icon's size-3 footprint.
  const RADIUS = 5;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const indeterminate = progress === null;
  const fraction = indeterminate ? 0.25 : Math.max(0, Math.min(1, progress));
  return (
    <span
      className={cn(TRAILING_SLOT, "opacity-80")}
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
  {
    icon,
    prefix,
    children,
    tone = "neutral",
    mono,
    onRemove,
    removeLabel,
    progress,
    progressLabel,
    className,
    ...rest
  },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex h-6 max-w-[14rem] shrink-0 items-center gap-2 rounded-8 border px-2 text-badge",
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {icon}
      <span className={cn("min-w-0 truncate", mono && "font-mono")}>
        {prefix != null && <span className="font-sans opacity-70">{prefix} </span>}
        {children}
      </span>
      {progress !== undefined && <UploadRing progress={progress} label={progressLabel} />}
      {progress === undefined && onRemove && (
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
