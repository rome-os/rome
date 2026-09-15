import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "./cn.js";

type ListRowSize = "sm" | "md";

/**
 * The two steps of the list-row scale: `sm` is a 36px floor for a dense list
 * of one-line records, `md` a 40px floor for a list whose rows carry a title
 * and a description. Each step sits 8px above the control step of the same
 * name, so a row is the taller of the two whatever it holds. Each reads its
 * own `--row-*` tokens, never a `--control-*` one.
 */
const sizeClasses: Record<ListRowSize, string> = {
  sm: "min-h-[var(--row-h-sm)] px-[var(--row-px-sm)] py-[var(--row-py-sm)]",
  md: "min-h-[var(--row-h-md)] px-[var(--row-px-md)] py-[var(--row-py-md)]",
};

/**
 * Hover and focus paint for a row that responds to a click. The focus edge is
 * drawn inset: a row is full-bleed inside its list, and most lists sit in a
 * clipped card, so an edge outside the box would be cut away on both sides.
 */
const interactiveClasses =
  "cursor-pointer transition-colors outline-none outline-1 -outline-offset-1 outline-transparent hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50";

const selectedFill = "bg-primary/10";

/* The deeper fill answers a pointer over the row, so it belongs to a row the
   pointer can act on. */
const selectedHoverFill = "hover:bg-primary/15";

export interface ListProps extends React.ComponentProps<"div"> {
  /**
   * Renders the child element as the list, so a `<ul>` or an `<ol>` can own the
   * separator. Reach for it when the records are a list in the document's own
   * terms and not only in the layout's.
   */
  asChild?: boolean;
}

/**
 * The rows of one list. Owns the separator between rows, so a row never draws
 * a border of its own and the last row needs no special case.
 */
export function List({ asChild = false, className, ...props }: ListProps) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp data-slot="list" className={cn("divide-y divide-border-subtle", className)} {...props} />
  );
}

interface ListRowBaseProps extends React.ComponentProps<"div"> {
  size?: ListRowSize;
  selected?: boolean;
}

/**
 * `interactive` is accepted only alongside `asChild`. The paint it turns on
 * includes a focus edge, and the `div` a row renders by default takes no focus
 * and answers no key, so on its own it would look clickable to a pointer and
 * be unreachable without one. Passing a `<button>` or an `<a>` through
 * `asChild` is what makes the row a real target.
 */
export type ListRowProps = ListRowBaseProps &
  (
    | {
        /**
         * Renders the child element as the row, so a `<button>`, an `<a>` or an
         * `<li>` under a `List asChild` can be one.
         */
        asChild: true;
        /**
         * Paints hover and focus states. Set it when the row itself is the
         * click target. A row whose interactivity depends on its data passes a
         * `boolean` here, which is why this arm is not the literal `true`.
         */
        interactive?: boolean;
      }
    | {
        asChild?: false;
        interactive?: false;
      }
  );

/**
 * One record in a list: a fixed horizontal inset, a height floor, and the gap
 * between its leading, content, and trailing parts.
 *
 * Reach for `TableRow` instead when the records share aligned columns and a
 * header names them. Reach for `Card` when each record is a block of its own
 * with a border and several lines of content.
 *
 * The row is a flex row. A caller that needs columns lined up across rows
 * passes `grid` and a template in `className`, and keeps the inset, the floor,
 * and the interaction paint.
 */
export function ListRow({
  size = "md",
  interactive = false,
  selected = false,
  asChild = false,
  className,
  ...props
}: ListRowProps) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-slot="list-row"
      data-size={size}
      data-selected={selected || undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 text-left text-ui text-foreground",
        sizeClasses[size],
        interactive && interactiveClasses,
        selected && selectedFill,
        selected && interactive && selectedHoverFill,
        className,
      )}
      {...props}
    />
  );
}

/** The part that takes the row's remaining width and truncates before it overflows. */
export function ListRowContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="list-row-content" className={cn("min-w-0 flex-1", className)} {...props} />
  );
}

export function ListRowTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="list-row-title"
      className={cn("text-ui text-foreground", className)}
      {...props}
    />
  );
}

export function ListRowDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="list-row-description"
      className={cn("text-aux text-muted-foreground", className)}
      {...props}
    />
  );
}
