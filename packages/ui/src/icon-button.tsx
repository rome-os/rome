import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn.js";

type IconButtonSize = "xs" | "sm" | "md" | "lg";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  /** Required accessible label. Used for both `aria-label` and `title`. */
  label: string;
  /** The icon node — typically a 16–20px `<svg>` from `@radix-ui/react-icons` or `lucide-react`. */
  icon: ReactNode;
  /**
   * The shared control vocabulary: `sm` = 28px, `md` = 36px, `lg` = 44px, off
   * `--control-h-*`, so an icon button and a `Button` or field named the same
   * size are the same box. `xs` = 24×24px sits below the scale — the WCAG
   * 2.5.8 minimum, for an action inside a row rather than beside it.
   *
   * Every step under 44px pairs with the `touch-target` class from
   * `@rome-os/ui/styles.css` on a touch-reachable surface, which raises the
   * control to the 44px floor where the device has no pointer. Only `lg`
   * clears the floor on its own.
   */
  size?: IconButtonSize;
}

// Height and radius are the shared scale, one step each, in the same bracket
// form as `Button`'s `icon-*` variants — the two are value-identical at every
// shared name, so a toolbar built from both cannot come out ragged. `xs` is the
// one step off the scale, and takes the `sm` radius because the scale has
// nothing smaller.
//
// A comment never spells a bracket utility, here or anywhere the scanner
// reaches. Tailwind extracts candidates from comments too, and an elided one
// compiles to a real arbitrary-value class that `check:ui:tailwind` then
// reports against an element that does not exist.
//
// The glyph size rides the step too, and only the two small ones restate it —
// the base below holds the 16px the other two take, exactly as `Button` is
// arranged.
const sizeClasses: Record<IconButtonSize, string> = {
  xs: "size-6 rounded-[var(--control-r-sm)] [&_svg:not([class*='size-'])]:size-3",
  sm: "size-[var(--control-h-sm)] rounded-[var(--control-r-sm)] [&_svg:not([class*='size-'])]:size-3.5",
  md: "size-[var(--control-h-md)] rounded-[var(--control-r-md)]",
  lg: "size-[var(--control-h-lg)] rounded-[var(--control-r-lg)]",
};

/**
 * Square icon-only button with a required accessible label.
 *
 * Sizing follows the row it sits in, because the names compose: `md` beside a
 * `md` Button, `sm` in a dense toolbar, `xs` for an action inside a row rather
 * than beside it — `sm` would fill a 28px row edge to edge, so `xs` is the step
 * that leaves a gap inside one.
 *
 * The glyph is the caller's, and the step it sits in decides the size: 12px in
 * an `xs` box, 14px in `sm`, 16px in `md` and `lg`. Those are the sizes
 * `Button`'s matching `icon-*` variant gives an unclassed glyph, so a toolbar
 * mixing the two keeps one optical inset as well as one box.
 *
 * A glyph carrying a `size-*` of its own keeps it. Only that spelling opts out:
 * `h-4 w-4` leaves the step's rule matching, and the rule wins on specificity.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-slot="icon-button"
      data-size={size}
      aria-label={label}
      title={label}
      className={cn(
        // Focus is a single 2px outline just outside the box, where it separates
        // from the canvas rather than from the fill. The transparent border is a
        // width reservation only, and the background deliberately paints under
        // it: clipping to the padding box would leave a canvas-colored ring
        // between a filled control and its outline.
        // `text-ui` carries no glyph of its own here — it sets the font size an
        // em-sized icon and any tooltip resolve against, so the control does not
        // fall back to the document default. Every step keeps it, including the
        // 44px one: a square member carries no label to scale.
        //
        // The glyph opt-out sits in the selector rather than in `cn` because it
        // has to: the caller's class lands on the `<svg>` while this rule lives
        // on the button, and tailwind-merge reconciles one element at a time,
        // so it never sees the collision.
        "inline-flex shrink-0 items-center justify-center rounded-8 border border-transparent text-ui text-foreground transition hover:bg-surface-hover outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        sizeClasses[size],
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
