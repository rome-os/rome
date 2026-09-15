import type { ComponentProps } from "react";
import * as ToolbarPrimitive from "@radix-ui/react-toolbar";
import { cn } from "./cn.js";

/*
 * Radix Toolbar, dressed for Rome. The role it adds is keyboard navigation: one
 * tab stop for the whole group, then arrow keys between the controls inside it.
 * A page toolbar holding six buttons otherwise costs six tab stops before the
 * content the reader came for.
 *
 * The parts carry no geometry of their own. A control inside a toolbar stays a
 * kit `Button`, `IconButton`, or `Toggle`, passed through `asChild` so it keeps
 * its own step, padding, and focus edge while the toolbar hands it the roving
 * tab index.
 *
 * Only the Radix parts join the roving order. A field dropped into a toolbar —
 * a search `Input` — keeps its own tab stop, which is what a text control needs.
 */

export interface ToolbarProps extends ComponentProps<typeof ToolbarPrimitive.Root> {
  /** Required: a toolbar with no accessible name reads as an unlabelled group. */
  "aria-label": string;
}

export function Toolbar({ className, ...props }: ToolbarProps) {
  return (
    <ToolbarPrimitive.Root
      data-slot="toolbar"
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

/** A control in the roving order. Wrap a kit `Button` with `asChild`. */
export function ToolbarButton({
  className,
  ...props
}: ComponentProps<typeof ToolbarPrimitive.Button>) {
  return <ToolbarPrimitive.Button data-slot="toolbar-button" className={className} {...props} />;
}

/** A link in the roving order. Wrap an anchor with `asChild`. */
export function ToolbarLink({ className, ...props }: ComponentProps<typeof ToolbarPrimitive.Link>) {
  return <ToolbarPrimitive.Link data-slot="toolbar-link" className={className} {...props} />;
}

export function ToolbarSeparator({
  className,
  ...props
}: ComponentProps<typeof ToolbarPrimitive.Separator>) {
  return (
    <ToolbarPrimitive.Separator
      data-slot="toolbar-separator"
      className={cn("mx-1 h-4 w-px shrink-0 bg-border", className)}
      {...props}
    />
  );
}

export function ToolbarToggleGroup({
  className,
  ...props
}: ComponentProps<typeof ToolbarPrimitive.ToggleGroup>) {
  return (
    <ToolbarPrimitive.ToggleGroup
      data-slot="toolbar-toggle-group"
      className={cn("flex items-center gap-1", className)}
      {...props}
    />
  );
}

/** A pressed control in the roving order. Wrap a kit `Toggle` with `asChild`. */
export function ToolbarToggleItem({
  className,
  ...props
}: ComponentProps<typeof ToolbarPrimitive.ToggleItem>) {
  return (
    <ToolbarPrimitive.ToggleItem data-slot="toolbar-toggle-item" className={className} {...props} />
  );
}
