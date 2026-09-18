import type { ComponentProps } from "react";
import { cn } from "./cn.js";
import { Toolbar, type ToolbarProps } from "./toolbar.js";

/*
 * The List body: what a page stacks inside `Page` when the reader's task is to
 * scan or search a collection, find one item, and leave. Slot table and
 * responsive behaviour: docs/ui/layouts.md.
 *
 * There is no `ListLayout`. A List renders into `Page` — the same padding and
 * the same rhythm every other page takes — so a wrapper here would name the
 * layout without owning any of it.
 */

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
