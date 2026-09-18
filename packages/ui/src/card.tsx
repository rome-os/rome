import type { ComponentProps } from "react";
import { cn } from "./cn.js";

/*
 * shadcn's `card` (new-york-v4), restyled to Rome's panel idiom. The structure
 * is upstream's verbatim — the `data-slot` attributes, the container-query
 * header grid, the `CardAction` cell, the `[.border-b]` / `[.border-t]`
 * self-padding — so an app swapping its copied shadcn card for this one gets
 * the same anatomy it already writes against.
 *
 * Rome's side is the paint and the scale:
 *
 *   - `bg-surface` / `text-surface-foreground` in place of `bg-card` /
 *     `text-card-foreground`. The dashboard aliases `--card: var(--surface)`,
 *     so the two resolve identically there, but only `--surface` is declared
 *     by every theme block — the alias is host-local, and the kit must not
 *     depend on a host having it.
 *   - `rounded-12`, the panel step of the radius scale, not `rounded-16`.
 *   - Flat: no `shadow-sm`. Dashboard panels sit on `background` and the
 *     `border-border` hairline is what separates them.
 *   - 16px inset and 4px title/description gap, against upstream's 24px/8px.
 *
 * The one structural deviation: `CardTitle` renders `h3` rather than a `div`,
 * because a Rome panel is a titled section and the pages it replaces use real
 * headings. A card whose heading belongs at another level passes its own
 * heading element as a child instead.
 */

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-12 border border-border bg-surface py-4 text-surface-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 data-slot="card-title" className={cn("text-section", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      // UI, like the Dialog and EmptyState descriptions: a description sits at
      // the size of the controls it explains and leads by ink, not by size.
      className={cn("text-ui text-muted-foreground", className)}
      {...props}
    />
  );
}

/** Trailing control in a CardHeader — the header grid gives it its own cell. */
export function CardAction({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2 px-4 [.border-t]:pt-4", className)}
      {...props}
    />
  );
}
