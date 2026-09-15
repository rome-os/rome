import type { ComponentProps } from "react";
import { cn } from "./cn.js";
import { Page } from "./page.js";
import { Toolbar, type ToolbarProps } from "./toolbar.js";

/*
 * The list layout. Slot table and responsive behaviour: docs/ui/layouts.md.
 */

/**
 * Used for a collection the reader scans or searches to find one item and then
 * leaves. Not used when the reader processes items one by one while keeping the
 * list in view, which is `SplitLayout`.
 *
 * Slots: `PageHeader`, `ListToolbar`, `ListCollection`, `ListFooter`.
 */
export function ListLayout({ className, ...props }: ComponentProps<"div">) {
  return (
    <Page data-slot="list-layout" className={cn("flex flex-col gap-6", className)} {...props} />
  );
}

/**
 * Search, filters, and the controls that narrow the collection. One tab stop for
 * the row, then arrow keys between the controls inside it.
 */
export function ListToolbar({ className, ...props }: ToolbarProps) {
  return <Toolbar data-slot="list-toolbar" className={className} {...props} />;
}

/**
 * The collection itself. Scrolls sideways rather than widening the page, so a
 * table with more columns than the viewport holds still leaves the header put.
 */
export function ListCollection({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="list-collection"
      className={cn("w-full min-w-0 overflow-x-auto", className)}
      {...props}
    />
  );
}

/** The card-grid form of a collection, for a caller not using a table. */
export function ListGrid({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="list-grid"
      className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3", className)}
      {...props}
    />
  );
}

/** Pagination, a count, or a load-more control under the collection. */
export function ListFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="list-footer"
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
      {...props}
    />
  );
}
