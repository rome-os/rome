import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./cn.js";
import { canonicalControlSize } from "./control-size.js";

// The 36px step, held in a const because two names resolve to it — `md`, the
// shared control vocabulary's name for the step, and the older `default`. Same
// arrangement as `Button`, so the two agree on both spellings.
const SIZE_MD =
  "h-[var(--control-h-md)] rounded-[var(--control-r-md)] px-[var(--control-px-start-md)]";
const ICON_PAD_MD = "pl-[calc(var(--control-px-start-md)+1rem+var(--control-gap))]";

// The glyph rides the size axis, same ladder as `Button` and `SelectTrigger`:
// 14px on the 28px step, 16px on 36 and 44. A field and a button named the same
// size therefore agree on their glyph as well as their height.
//
// No `:not([class*='size-'])` opt-out, unlike Button and IconButton, and for
// the reason EmptyStateIcon has none either: the field reserves room for the
// glyph as `padding-left` on the `<input>` beside it, and no CSS makes one
// element's padding track another element's width. The reserve is a `calc` of
// the step's length — 0.875rem at `sm`, 1rem elsewhere — so a glyph that opted
// out would keep an inset it no longer fits and run into the text. A component
// whose reserved geometry cannot follow the glyph normalizes it instead; a
// caller who wants a different glyph changes the field's size.
// The two spellings of that one number move together. Change the class here and
// the `calc` in the compound variants below, or the label stops sitting exactly
// one control gap past the glyph.
// Both maps are indexed `size ?? "md"`. The `??` is not redundant with the
// destructuring default: `size` is `cva`'s variant type, which admits `null`,
// and a default only fires for `undefined`.
const iconSizeClass = {
  sm: "[&_svg]:size-3.5",
  md: "[&_svg]:size-4",
  default: "[&_svg]:size-4",
  lg: "[&_svg]:size-4",
} as const;

const inputVariants = cva(
  // UI is the field role at every size and breakpoint, the role of the Button
  // and SelectTrigger on the field's row. The host's viewport meta suppresses
  // iOS Safari's focus zoom below 16px, so nothing restores Body.
  //
  // The role stays in the base rather than moving onto each size, because
  // `size` admits `null` and cva emits no variant class for it. A null-size
  // field would otherwise declare no role at all and fall back to the document
  // size.
  "w-full min-w-0 border border-input bg-transparent text-ui transition-colors enabled:hover:border-border-strong outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-ui file:text-foreground placeholder:text-muted-foreground outline-1 -outline-offset-1 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:outline-solid aria-invalid:outline-2 aria-invalid:outline-offset-0 aria-invalid:outline-destructive dark:bg-input/30 dark:disabled:bg-input/80",
  {
    variants: {
      // Geometry comes from the --control-* scale, and the names match
      // `Button`'s so the same size value on both yields the same height on one
      // row. Height is explicit and the border sits inside the box, so focus
      // and invalid borders never shift layout.
      size: {
        sm: "h-[var(--control-h-sm)] rounded-[var(--control-r-sm)] px-[var(--control-px-start-sm)]",
        md: SIZE_MD,
        /** @deprecated Spelling of `md` that predates the shared vocabulary. */
        default: SIZE_MD,
        /**
         * @deprecated No replacement. 44px is a prominence step for a
         * standalone call to action, and a field never appears in one of those
         * rows — no call site has ever asked for it. Retain existing usage; add
         * none pending removal.
         */
        lg: "h-[var(--control-h-lg)] rounded-[var(--control-r-lg)] px-[var(--control-px-start-lg)]",
      },
      /**
       * A leading icon rides the field's own padding rather than a hand-picked
       * step: the glyph sits at the inline padding, and the text starts one
       * icon plus one control gap past it. Derived from the size step, so it
       * tracks a size change instead of needing a second edit.
       */
      hasIcon: { true: "", false: "" },
      /**
       * `plain` is a field inside a surface that already frames it — a command
       * palette's search row, a panel header. It paints no border, radius,
       * fill, or hover; the surface's edge is the frame. It keeps the step's
       * height, inset, glyph reserve, and focus edge. A caller whose surface
       * holds focus for its whole life suppresses the edge itself.
       */
      variant: {
        outlined: "",
        plain:
          "rounded-none border-transparent bg-transparent enabled:hover:border-transparent disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent",
      },
    },
    compoundVariants: [
      {
        size: "sm",
        hasIcon: true,
        className: "pl-[calc(var(--control-px-start-sm)+0.875rem+var(--control-gap))]",
      },
      { size: "md", hasIcon: true, className: ICON_PAD_MD },
      { size: "default", hasIcon: true, className: ICON_PAD_MD },
      {
        size: "lg",
        hasIcon: true,
        className: "pl-[calc(var(--control-px-start-lg)+1rem+var(--control-gap))]",
      },
    ],
    defaultVariants: { size: "md", hasIcon: false, variant: "outlined" },
  },
);

const iconInsetClass = {
  sm: "left-[var(--control-px-start-sm)]",
  md: "left-[var(--control-px-start-md)]",
  default: "left-[var(--control-px-start-md)]",
  lg: "left-[var(--control-px-start-lg)]",
} as const;

// `size` is a native `<input>` attribute (a character count), so the variant
// name has to displace it rather than sit beside it.
export interface InputProps
  extends Omit<React.ComponentProps<"input">, "size">,
    Pick<VariantProps<typeof inputVariants>, "size" | "variant"> {
  /** Leading glyph rendered inside the field, sized and inset from the size step. */
  icon?: React.ReactNode;
}

/**
 * The leading glyph's seat, absolutely positioned against a `relative` parent
 * at the size step's inset. Exported for a composite that renders the
 * `<input>` itself, such as `CommandInput`, so its glyph sits where `Input`
 * seats one.
 */
function InputGlyph({
  size = "md",
  children,
}: {
  size?: VariantProps<typeof inputVariants>["size"];
  children: React.ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="input-icon"
      data-size={canonicalControlSize(size)}
      className={cn(
        // `inset-y-0` plus `items-center` centers the glyph against the
        // field's own box, so it needs no transform and no height of its own.
        //
        // The step sets the glyph size, unconditionally — see `iconSizeClass`.
        "pointer-events-none absolute inset-y-0 flex items-center text-muted-foreground",
        iconSizeClass[size ?? "md"],
        iconInsetClass[size ?? "md"],
      )}
    >
      {children}
    </span>
  );
}

function Input({ className, type, size = "md", variant = "outlined", icon, ...props }: InputProps) {
  const field = (
    <input
      type={type}
      data-slot="input"
      data-size={canonicalControlSize(size)}
      data-variant={variant}
      className={cn(inputVariants({ size, variant, hasIcon: Boolean(icon) }), className)}
      {...props}
    />
  );

  if (!icon) return field;

  return (
    <div className="relative w-full">
      <InputGlyph size={size}>{icon}</InputGlyph>
      {field}
    </div>
  );
}

export { Input, InputGlyph, inputVariants };
