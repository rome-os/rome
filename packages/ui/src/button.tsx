import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "./cn.js";
import { canonicalControlSize } from "./control-size.js";

// The 36px step, held in a const because two names resolve to it: `md`, the
// shared control vocabulary's name for the step, and `default`, the shadcn
// spelling that predates it. Same for the square variant below. Both spellings
// stay declared so existing callers and `buttonVariants` consumers keep
// working; `md` is the one to write.
const SIZE_MD =
  "h-[var(--control-h-md)] gap-[var(--control-gap)] rounded-[var(--control-r-md)] px-[var(--control-px-center-md)]";
const SIZE_ICON_MD = "size-[var(--control-h-md)] rounded-[var(--control-r-md)]";

// The transparent border is the width reservation, and that is its whole job:
// height is explicit but width is auto, so a variant that paints a border —
// `outline`, or a caller's own `border-destructive` — must not make the box
// wider than the variant beside it. Nothing paints it by default and nothing
// reads it, so it looks removable and is not. `docs/ui/component-roles.md`
// carries the rule; `border-layout-invariant.test.ts` enforces it.
//
// The background is not clipped to the padding box, so a fill paints under that
// transparent border and reaches the edge the focus outline sits against. Clip
// it and the reservation shows up as a canvas-colored ring on every filled
// variant.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center border border-transparent text-ui whitespace-nowrap transition-all outline-none select-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:outline-solid aria-invalid:outline-2 aria-invalid:outline-offset-0 aria-invalid:outline-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // `outline` and `ghost` name their resting foreground, which the page
      // would otherwise supply by inheritance — so inside a status-colored card
      // the label stayed neutral only by accident. Naming it makes the `hover:`
      // and `aria-expanded:` promotions below look dead, and they are not: a
      // caller that de-emphasizes the control writes a bare
      // `text-muted-foreground`, which lands in a different tailwind-merge group
      // than the prefixed ones, so the promotion still fires.
      variant: {
        // The label competes with its own fill rather than with the page, so
        // it carries 500 on top of the UI role.
        default: "bg-primary text-primary-foreground font-medium hover:bg-primary/80",
        // Paints its border, so the focus edge sits on that border. The filled
        // and ghost variants keep the edge outside, where it separates from
        // the canvas rather than vanishing into the fill.
        outline:
          "-outline-offset-1 border-border bg-background text-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "text-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:outline-destructive/50 dark:bg-destructive/20 dark:hover:bg-destructive/30",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Height, radius, gap and padding all come from the --control-* scale in
      // globals.css so a Button and an Input on the same row match exactly:
      // `sm` is 28px, `md` 36px and `lg` 44px on every control that names them.
      // A centred label reads the `center` group; `align` below swaps in the
      // `start` group when the label becomes an alignment edge. `xs` is
      // deliberately below the scale — a 24px chip-sized button for dense
      // toolbars, with no field counterpart to line up with — so it pads from a
      // spacing step, neither group carrying a step that low.
      size: {
        xs: "h-6 gap-1 rounded-[var(--control-r-sm)] px-2 in-data-[slot=button-group]:rounded-8 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-[var(--control-h-sm)] gap-[var(--control-gap)] rounded-[var(--control-r-sm)] px-[var(--control-px-center-sm)] in-data-[slot=button-group]:rounded-8 [&_svg:not([class*='size-'])]:size-3.5",
        md: SIZE_MD,
        /** @deprecated Spelling of `md` that predates the shared vocabulary. */
        default: SIZE_MD,
        "icon-xs":
          "size-6 rounded-[var(--control-r-sm)] in-data-[slot=button-group]:rounded-8 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-[var(--control-h-sm)] rounded-[var(--control-r-sm)] in-data-[slot=button-group]:rounded-8 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-md": SIZE_ICON_MD,
        /** @deprecated Spelling of `icon-md` that predates the shared vocabulary. */
        icon: SIZE_ICON_MD,
        "icon-lg": "size-[var(--control-h-lg)] rounded-[var(--control-r-lg)]",
      },
      // Corner treatment, orthogonal to size. `pill` exists because a few
      // surfaces (the composer, the routines health indicator) read as pill
      // affordances rather than control-scale ones; it overrides only the
      // radius, so height, padding and type still come from `size`.
      //
      // The `pill` / `square` vocabulary is Badge's — same prop, same meaning:
      // `square` is "this primitive's normal corner", not a zero radius. The
      // defaults differ on purpose, because a badge reads as a pill by default
      // and a control does not.
      //
      // MUST stay declared after `size`: cva concatenates variant classes in
      // declaration order and `cn` resolves the collision by last-wins, so a
      // `shape` above `size` would silently lose. On an `icon-*` size this
      // yields a circle.
      shape: {
        square: "",
        pill: "rounded-full",
      },
      /**
       * How the label sits in the box, which decides which padding group it
       * reads. A centred label is not an alignment edge — nothing lines up
       * against it — so it takes `--control-px-center-*`. A label pushed to the
       * start is an edge, shared with every start-aligned control in the same
       * column, so it takes `--control-px-start-*` instead. `between` is
       * `start` plus a trailing slot: its first child still sits on that edge.
       *
       * MUST stay declared after `size`, for the reason `shape` does: the
       * compound rows below override the padding `size` set, and `cn` resolves
       * that collision by last-wins.
       */
      align: {
        center: "justify-center",
        start: "justify-start",
        between: "justify-between",
      },
    },
    compoundVariants: [
      // A glyph at the edge of a centred label sits one `--control-gap` from
      // that edge, the distance it sits from the label. The glyph names its
      // side with `data-icon`, because a bare-text label leaves a lone glyph
      // both first and last element child. Square members hold no padding,
      // `xs` reads no token, and a start-aligned glyph sits on the alignment
      // edge, so none of those take it.
      {
        align: "center",
        size: ["sm", "md", "default"],
        className:
          "has-data-[icon=inline-start]:pl-[var(--control-gap)] has-data-[icon=inline-end]:pr-[var(--control-gap)]",
      },
      { align: "start", size: "sm", className: "px-[var(--control-px-start-sm)]" },
      { align: "start", size: ["md", "default"], className: "px-[var(--control-px-start-md)]" },
      { align: "between", size: "sm", className: "px-[var(--control-px-start-sm)]" },
      { align: "between", size: ["md", "default"], className: "px-[var(--control-px-start-md)]" },
    ],
    defaultVariants: {
      variant: "default",
      size: "md",
      shape: "square",
      align: "center",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "md",
  shape = "square",
  align = "center",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={canonicalControlSize(size)}
      data-shape={shape}
      data-align={align}
      className={cn(buttonVariants({ variant, size, shape, align, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
