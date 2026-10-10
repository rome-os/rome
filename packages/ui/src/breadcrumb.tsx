import { Slot } from "@radix-ui/react-slot";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import * as React from "react";

import { cn } from "./cn.js";

function Breadcrumb({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav aria-label="breadcrumb" data-slot="breadcrumb" className={cn(className)} {...props} />
  );
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "flex flex-wrap items-center gap-0.5 text-ui wrap-break-word text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex min-w-0 items-center", className)}
      {...props}
    />
  );
}

// Ancestors render as ghost chips so the hit area is the chip, not the bare
// glyphs. The current page shares the chip's padding so labels keep one
// baseline and one left edge whether or not they are links.
const crumbChip =
  "block min-w-0 truncate rounded-4 px-1 leading-6 outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";

function BreadcrumbLink({
  asChild,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot : "a";

  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn(
        crumbChip,
        "transition-colors hover:bg-surface-hover hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn(crumbChip, "font-medium text-foreground", className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      // The separator glyph is the caller's when they pass one, so the 14px
      // stands aside for a `size-*` of its own.
      className={cn("text-subtle-foreground [&>svg:not([class*='size-'])]:size-3", className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  );
}

/**
 * Stands in for the crumbs `collapseBreadcrumb` hides. It is a button so it
 * can be a menu trigger (`asChild` under `DropdownMenuTrigger`) that lists
 * them. `label` names the hidden crumbs for assistive tech.
 */
function BreadcrumbEllipsis({
  className,
  label = "Show hidden path",
  ...props
}: React.ComponentProps<"button"> & { label?: string }) {
  return (
    <button
      type="button"
      data-slot="breadcrumb-ellipsis"
      aria-label={label}
      className={cn(
        crumbChip,
        "flex h-6 items-center justify-center transition-colors hover:bg-surface-hover hover:text-foreground data-[state=open]:bg-surface-hover data-[state=open]:text-foreground [&>svg]:size-4",
        className,
      )}
      {...props}
    >
      <MoreHorizontal aria-hidden="true" />
    </button>
  );
}

/**
 * Splits a trail into what stays visible and what folds behind
 * `BreadcrumbEllipsis`. A trail longer than `maxVisible` keeps its first
 * crumb and its last `maxVisible - 2`; the ellipsis takes the remaining
 * slot. `hidden` is empty when nothing folds. `maxVisible` below 3 is
 * treated as 3.
 */
function collapseBreadcrumb<T>(
  trail: readonly T[],
  maxVisible = 4,
): { leading: T[]; hidden: T[]; trailing: T[] } {
  const max = Math.max(3, maxVisible);
  if (trail.length <= max) return { leading: [...trail], hidden: [], trailing: [] };
  const tailCount = max - 2;
  return {
    leading: trail.slice(0, 1),
    hidden: trail.slice(1, trail.length - tailCount),
    trailing: trail.slice(trail.length - tailCount),
  };
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
  collapseBreadcrumb,
};
