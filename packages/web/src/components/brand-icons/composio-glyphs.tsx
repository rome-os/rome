import type { ReactNode } from "react";
import { Plug } from "lucide-react";

import { cn } from "@/lib/utils";

/* Monochrome glyphs for the services Rome reaches through Composio, keyed by
   the catalog's `glyph` id. The Connector app draws the same marks in its
   in-chat connect card (`rome_apps/connector/src/web/components/AppGlyph.tsx`);
   keep the two in step when a service is added. GitHub, Slack and Shopify are
   left out: Rome connects those itself, never through Composio. */
const COMPOSIO_GLYPHS: Record<string, ReactNode> = {
  calendar: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    </svg>
  ),
  gmail: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M3.6 7 12 13l8.4-6" />
    </svg>
  ),
  notion: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M9.2 16V8.4l5.6 7.2V8" />
    </svg>
  ),
  drive: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <path d="m12 4 7.6 13H4.4L12 4Z" />
      <path d="M8.2 10.7 4.5 17M15.8 10.7 19.5 17M8.3 17h7.4" />
    </svg>
  ),
  linear: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <path d="M4 14.6 9.4 20M4 10.2 13.8 20M5.6 6.8 17.2 18.4M9.8 5 19 14.2M14.4 4.2l5.4 5.4" />
    </svg>
  ),
  discord: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" aria-hidden="true">
      <path d="M19.3 6.5A16 16 0 0 0 15.4 5.2l-.25.5a14.7 14.7 0 0 1 3.3 1.1 12.6 12.6 0 0 0-12.9 0 14.7 14.7 0 0 1 3.3-1.1l-.25-.5A16 16 0 0 0 4.7 6.5C2.5 9.8 1.9 13.1 2.2 16.3a16.3 16.3 0 0 0 4.9 2.5l.6-1.05c-.32-.12-.64-.27-.94-.45.08-.06.16-.12.23-.18a11.7 11.7 0 0 0 10 0c.08.06.15.12.23.18-.3.18-.62.33-.94.45l.6 1.05a16.2 16.2 0 0 0 4.9-2.5c.36-3.74-.6-7-2.5-9.8ZM9 14.4c-.95 0-1.74-.88-1.74-1.97 0-1.08.77-1.96 1.74-1.96.97 0 1.76.88 1.74 1.96 0 1.09-.78 1.97-1.74 1.97Zm6 0c-.95 0-1.74-.88-1.74-1.97 0-1.08.77-1.96 1.74-1.96.97 0 1.76.88 1.74 1.96 0 1.09-.77 1.97-1.74 1.97Z" />
    </svg>
  ),
  linkedin: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" aria-hidden="true">
      <path d="M4.98 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM3 9.5h4v11H3v-11Zm6.5 0h3.8v1.5h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.75v5.7h-4v-5.05c0-1.2-.02-2.75-1.9-2.75-1.9 0-2.2 1.3-2.2 2.65v5.15h-4v-11Z" />
    </svg>
  ),
  outlook: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <rect x="4" y="4.5" width="16" height="15" rx="3" />
      <ellipse cx="12" cy="12" rx="3.6" ry="4.4" />
    </svg>
  ),
  sheets: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9.5h16M4 14.5h16M10 4v16" />
    </svg>
  ),
  docs: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <path d="M7 3.5h6.5L18 8v12.5H7z" />
      <path d="M13.5 3.5V8H18M9.5 12.5h5M9.5 15.5h5" />
    </svg>
  ),
  slides: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <rect x="4" y="5" width="16" height="13" rx="2" />
      <path d="M9 21h6M12 18v3M8.5 9.5h7M8.5 12.5h4" />
    </svg>
  ),
  googleads: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <path d="M5.2 17.6 12 5.8l6.8 11.8" />
      <path d="M8.2 12.4h7.6" />
      <circle cx="12" cy="17.6" r="2.4" />
    </svg>
  ),
  dropbox: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" aria-hidden="true">
      <path d="M6 1.807 0 5.629l6 3.822 6.001-3.822zM18 1.807l-6 3.822 6 3.822 6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452zM18 9.452l-6 3.822 6 3.822 6-3.822zM6 18.371l6.001 3.822L18 18.371l-6-3.822z" />
    </svg>
  ),
  hubspot: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <circle cx="11" cy="14" r="3.2" />
      <circle cx="11" cy="4.6" r="1.7" />
      <circle cx="18.2" cy="8.4" r="1.7" />
      <path d="M11 10.8V6.3M13.7 12.2l3-2.5" />
    </svg>
  ),
  metaads: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <path d="M5 15.5c1.3-4.2 3-7 5-7 1.4 0 2.4 1.4 3.6 3.3 1.3 2.1 2.4 3.7 3.8 3.7 1.2 0 2-.9 2-2.1 0-1.5-1.1-2.6-2.6-2.6-2 0-3.5 1.8-5 4.7-1.4 2.6-2.3 3.7-3.8 3.7-1.7 0-3-1.6-3-3.7Z" />
      <path d="M5 15.5c0-3.7 1.4-6.7 3.9-6.7 1.5 0 2.7 1.4 4.7 4.8" />
    </svg>
  ),
  stripe: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" aria-hidden="true">
      <path d="M11.6 9.4c0-.7.6-1 1.5-1 1.3 0 2.7.4 4 1.1V5.8C15.7 5.3 14.3 5.1 13 5.1c-3.1 0-5.2 1.6-5.2 4.3 0 4.2 5.8 3.5 5.8 5.3 0 .8-.7 1.1-1.7 1.1-1.4 0-3.2-.6-4.6-1.4v3.8c1.5.7 3.1 1 4.6 1 3.2 0 5.4-1.6 5.4-4.3 0-4.5-5.8-3.7-5.8-5.5z" />
    </svg>
  ),
  supabase: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <path d="M13.4 3.7 5.2 13.2c-.7.8-.1 2.1 1 2.1h5.2l-.8 5c-.2 1.2 1.3 1.8 2.1.9l8.1-9.5c.7-.8.1-2.1-1-2.1h-5.2l.9-5c.2-1.2-1.4-1.8-2.1-.9Z" />
      <path d="M11.4 15.3h-4M14.6 9.6h3.8" />
    </svg>
  ),
  neon: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <path d="M5 17.8V6.2c0-1.1 1.3-1.7 2.1-.9l9.9 9.9V6.2" />
      <path d="M19 6.2v11.6c0 1.1-1.3 1.7-2.1.9L7 8.8v9" />
      <path d="M5 18.2h4.4M14.6 5.8H19" />
    </svg>
  ),
  otter: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 10.5v3M12 8.5v7M15.5 10.5v3" />
    </svg>
  ),
};

/** The badge for a Composio service row, sized like `ConnectionBrandBadge`.
 *  An unknown glyph falls back to a plug mark. */
export function ComposioServiceBadge({
  glyph,
  className,
}: {
  glyph: string | undefined;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-8 border border-border bg-surface text-foreground",
        className,
      )}
      aria-hidden
    >
      {(glyph && COMPOSIO_GLYPHS[glyph]) || <Plug className="h-5 w-5" />}
    </div>
  );
}
