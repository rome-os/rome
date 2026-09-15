import type { ComponentProps } from "react";
import { cn } from "./cn.js";

/*
 * The page frame and the section rhythm every layout in the catalogue composes.
 * The catalogue, the slot tables, and the responsive behaviour are in
 * docs/ui/layouts.md.
 *
 * No part here renders `main`. The dashboard shell owns the one `main`
 * landmark, and a second one nested inside it breaks landmark navigation for a
 * screen reader. A layout reaches for `div`, `section`, `header`, `aside`, or
 * `nav` instead.
 *
 * The frame is full-bleed: it fills the column beside the nav and centers
 * nothing. A page that needs a reading measure constrains itself below the
 * header through `Measure`, so the `h1` sits at the same spot on every route.
 */

/** The outer frame of a routed page. Owns the padding no page restates. */
export function Page({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="page" className={cn("w-full p-4 sm:p-6 lg:p-8", className)} {...props} />;
}

/**
 * The identity block at the top of a page: an optional `PageHeaderNav`, a
 * `PageHeading` carrying the title and description, and an optional
 * `PageActions`. The nav takes its own line, and the actions sit opposite the
 * heading on the line below it.
 *
 * `align` picks which edge the two sides meet on. A control is taller than the
 * title's line box — 36px against 24px — so it overhangs whichever end it is
 * not aligned to, and the page picks the end that reads as one row:
 *
 * - `end` when `PageActions` holds a single control that shares the title's
 *   row, so the control's bottom edge rests on the title's line box instead of
 *   hanging below it. A page-level view switch is the case this exists for.
 * - `start` when the actions may wrap or stack, which is every header carrying
 *   more than one control. Aligning those to the end would push the first row
 *   up off the title.
 */
export function PageHeader({
  align = "start",
  className,
  ...props
}: ComponentProps<"header"> & { align?: "start" | "end" }) {
  return (
    <header
      data-slot="page-header"
      data-align={align}
      className={cn(
        "flex flex-wrap justify-between gap-x-4 gap-y-2",
        align === "end" ? "items-end" : "items-start",
        className,
      )}
      {...props}
    />
  );
}

/** Breadcrumb or back link above the title. */
export function PageHeaderNav({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="page-header-nav" className={cn("basis-full", className)} {...props} />;
}

/** Groups the title with its description so the actions stay opposite both. */
export function PageHeading({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="page-heading"
      className={cn("flex min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

/** The one `h1` a page carries. */
export function PageTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1 data-slot="page-title" className={cn("text-title text-foreground", className)} {...props} />
  );
}

export function PageDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="page-description"
      className={cn("text-ui text-muted-foreground", className)}
      {...props}
    />
  );
}

/** Page-level controls, opposite the heading. */
export function PageActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="page-actions"
      className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

/** The column below the header. Holds its blocks 24px apart. */
export function PageBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="page-body"
      className={cn("flex min-w-0 flex-col gap-6", className)}
      {...props}
    />
  );
}

/** A titled block inside a page. Holds its own contents 12px apart. */
export function Section({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="section"
      className={cn("flex min-w-0 flex-col gap-3", className)}
      {...props}
    />
  );
}

/**
 * The heading block of a `Section`: a `SectionHeading` and an optional
 * `SectionActions` opposite it.
 */
export function SectionHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="section-header"
      className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-1", className)}
      {...props}
    />
  );
}

export function SectionHeading({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="section-heading"
      className={cn("flex min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

/** The `h2` a section carries. */
export function SectionTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      data-slot="section-title"
      className={cn("text-section text-foreground", className)}
      {...props}
    />
  );
}

export function SectionDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="section-description"
      className={cn("text-ui text-muted-foreground", className)}
      {...props}
    />
  );
}

export function SectionActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="section-actions"
      className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

/**
 * Caps its contents at the reading measure. Sits below the header, never
 * around it, so the header keeps the same position across routes.
 */
export function Measure({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="measure" className={cn("w-full max-w-2xl", className)} {...props} />;
}
