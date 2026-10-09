import * as React from "react";
import type { VariantProps } from "class-variance-authority";

import type { buttonVariants } from "./button.js";

type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

/*
 * Internal — no subpath export, so this is not published API. `Button` and
 * `Toggle` share it so two members on one row apply the role's glyph-edge
 * correction the same way.
 */

/**
 * A glyph is a childless component element, such as an icon or a spinner, or
 * a direct child marked with `data-icon`. A label is anything else, so text, a
 * wrapped `<span>`, and a `Kbd` hint all count. Only a glyph with a label on
 * the other side sits at an edge worth correcting.
 *
 * The test reads elements, not what they render, so a childless component
 * that renders text reads as a glyph. Such a label opts out by wrapping it in
 * a `<span>`, and a glyph the test misses (an inline `<svg>`, say) opts in
 * with `data-icon`. Only direct children and fragment members are read, so
 * a marked glyph inside a wrapper element is not seen. A screen-reader-only
 * `<span>` or a label hidden at some breakpoints (`hidden sm:inline`) also
 * counts as a label, so a visually lone icon beside one gets the trim. Give
 * such a button symmetric padding at the breakpoints where its label hides.
 */
function isGlyph(node: React.ReactNode): boolean {
  if (!React.isValidElement<{ children?: React.ReactNode; "data-icon"?: string }>(node)) {
    return false;
  }
  if (node.props["data-icon"] != null) return true;
  return typeof node.type !== "string" && node.props.children == null;
}

/**
 * Children with fragments opened, so `<><Plus />Add</>` reads as two items.
 * Blank strings render nothing, so `{label ?? ""}` beside an icon is no label.
 */
function flatten(children: React.ReactNode): React.ReactNode[] {
  return React.Children.toArray(children).flatMap((child) => {
    if (typeof child === "string" && child.trim() === "") return [];
    return React.isValidElement<{ children?: React.ReactNode }>(child) &&
      child.type === React.Fragment
      ? flatten(child.props.children)
      : [child];
  });
}

function glyphEdges(children: React.ReactNode): { start: boolean; end: boolean } {
  const items = flatten(children);
  const hasLabel = items.some((item) => !isGlyph(item));
  return {
    start: hasLabel && isGlyph(items[0]),
    end: hasLabel && isGlyph(items.at(-1)),
  };
}

/** The glyph-side inset, per step that takes it. Steps not listed take none. */
const GLYPH_EDGE: Partial<Record<ButtonSize, { start: string; end: string }>> = {
  sm: { start: "pl-[var(--control-px-icon-sm)]", end: "pr-[var(--control-px-icon-sm)]" },
  md: { start: "pl-[var(--control-px-icon-md)]", end: "pr-[var(--control-px-icon-md)]" },
  default: { start: "pl-[var(--control-px-icon-md)]", end: "pr-[var(--control-px-icon-md)]" },
};

/**
 * The glyph-side padding classes for content read from `children`, placed
 * before the caller's `className` so a caller's `px-*` still wins the merge.
 * Only a centred label takes them.
 */
export function glyphTrim(
  children: React.ReactNode,
  size: ButtonSize | null | undefined,
  align: string | null | undefined = "center",
): { start?: string; end?: string } {
  const inset = align === "center" && size ? GLYPH_EDGE[size] : undefined;
  if (!inset) return {};
  const edges = glyphEdges(children);
  return { start: edges.start ? inset.start : undefined, end: edges.end ? inset.end : undefined };
}
