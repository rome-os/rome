import { useMediaQuery } from "./use-media-query";

/**
 * Tailwind's `md` breakpoint as a media query. The shell flips the sidebar
 * from a mobile slide-over to an in-flow column at exactly this width, so JS
 * that varies sidebar behavior has to agree with the stylesheet on where
 * that flip happens.
 */
const DESKTOP_QUERY = "(min-width: 48rem)";

/**
 * True from Tailwind `md` up — the widths where the sidebar renders as an
 * in-flow column rather than a slide-over. Live-updates on window resize.
 */
export function useDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
