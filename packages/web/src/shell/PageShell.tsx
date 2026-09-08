import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Padding every routed page shares. Lives here so no page can drift off it.
 *  Uniform on both axes at every step, so the gap above a page's h1 matches the
 *  gap to its left. */
const PAGE_PADDING = "p-4 sm:p-6 lg:p-8";

/**
 * For a block that sticks to the bottom of the viewport: it takes over the
 * page's bottom padding as its own, so it sits the same distance from the
 * viewport's edge while stuck as it does at rest at the end of the page. A
 * floor without this jumps by the page padding the moment the page's end
 * scrolls into view. Kept beside `PAGE_PADDING` because the two have to agree
 * step for step.
 */
export const PAGE_FLOOR = "-mb-4 pb-4 sm:-mb-6 sm:pb-6 lg:-mb-8 lg:pb-8";

/**
 * The frame every routed page renders into.
 *
 * Deliberately full-bleed: it fills the column next to the nav sidebar and
 * never centers a narrower measure. A per-page `max-w-*` would move the `h1`
 * horizontally on every navigation, which reads as a flicker. Content that
 * genuinely needs a reading measure constrains itself *below* the header
 * instead, so the header stays put across routes.
 *
 * A plain `div`, not a `main`: `RomeShellLayout` already marks the content
 * column as the page's `main` landmark, and a second one nested inside it is
 * invalid document structure that breaks screen-reader landmark navigation.
 * Exactly one layer owns that landmark, and it is the layout.
 */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("w-full", PAGE_PADDING, className)}>{children}</div>;
}

/**
 * Vertical rhythm for a page's top-level blocks. `space-y-*` rather than a flex
 * `gap-*` so it still applies when a block renders a fragment or a bare child.
 */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("space-y-6", className)}>{children}</div>;
}
