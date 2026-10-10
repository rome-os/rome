import type { ComponentProps } from "react";
import { cn } from "./cn.js";

/*
 * The Form body: what a page stacks inside `Page` when the reader's task is to
 * change a setting and see the change took. Slot table and responsive
 * behaviour: docs/ui/layouts.md.
 *
 * There is no `FormLayout`. A Form renders into `Page` — the same padding and
 * the same rhythm every other page takes — so a wrapper here would name the
 * layout without owning any of it. That is also what lets a Form body sit under
 * a header and a nav the route already owns, as `/settings/appearance` does.
 *
 * Settings a reader returns to and changes one at a time read as rows — a label
 * on the left, its control on the right, stacked in one surface with hairline
 * dividers.
 */

/**
 * The surface a set of settings rows sits in, capped at the reading measure.
 * The cap sits here rather than on the frame, so the header keeps the same
 * position across routes. Divides its children with a hairline, so the rows
 * read as one block rather than as separate cards.
 */
export function FormRows({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="form-rows"
      className={cn(
        "w-full max-w-2xl divide-y divide-border overflow-hidden rounded-12 border border-border bg-surface",
        className,
      )}
      {...props}
    />
  );
}

/**
 * One setting: an optional `FormRowIcon`, a `FormRowHeading` that grows, and a
 * `FormRowControl` at the end. The icon column appears only when the row
 * carries one, so a set of rows with no icons keeps its labels at the inset.
 *
 * One line at every width. The heading wraps its own text rather than pushing
 * the control onto a second line, because a row that stacks on a narrow
 * viewport stops reading as a settings row exactly where the list is longest.
 *
 * The row floors at 64px, the box-size step above a `md` control inside the
 * row's insets, so a row carrying a control and a row carrying only text are
 * the same height.
 */
export function FormRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="form-row"
      className={cn(
        "grid min-h-16 grid-cols-[1fr_auto] items-center gap-3 px-4 py-3",
        "has-data-[slot=form-row-icon]:grid-cols-[auto_1fr_auto]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The muted tile that opens a row. Decoration: it repeats what the label says,
 * so it carries no text and nothing reads it out.
 */
export function FormRowIcon({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="form-row-icon"
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-8 bg-surface-muted text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

/** Groups a row's label with its description, so the control stays opposite both. */
export function FormRowHeading({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="form-row-heading"
      className={cn("flex min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

/**
 * What the row sets. Renders a real `label` when given `htmlFor`, and a `div`
 * otherwise: a row whose control is a group of buttons has no single element
 * for a label to point at, and a `for` aimed at nothing is worse than no label
 * at all.
 */
export function FormRowLabel({ className, htmlFor, ...props }: ComponentProps<"label">) {
  const classes = cn("text-ui text-foreground", className);
  if (htmlFor === undefined) {
    return (
      <div data-slot="form-row-label" className={classes} {...(props as ComponentProps<"div">)} />
    );
  }
  return <label data-slot="form-row-label" htmlFor={htmlFor} className={classes} {...props} />;
}

/** What the setting does, under the label. */
export function FormRowDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="form-row-description"
      className={cn("text-aux text-muted-foreground", className)}
      {...props}
    />
  );
}

/** The control the row sets its value with, at the row's end. */
export function FormRowControl({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="form-row-control"
      className={cn("flex shrink-0 items-center gap-2 justify-self-end", className)}
      {...props}
    />
  );
}
