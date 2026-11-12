/**
 * Touch-first devices: no hover capability and a coarse primary pointer.
 * This is the same signal `globals.css` uses to scope mobile-only rules
 * (e.g. the iOS input font-size fix), so "coarse pointer" means the same
 * thing in CSS and in JS.
 *
 * A phone/tablet with an attached hardware keyboard still matches — that is
 * intentional: the media query tracks the device class, not the currently
 * focused input method.
 */
export const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";

/** Rome running as an installed home-screen app, with no browser tabs around it. */
export const STANDALONE_DISPLAY_QUERY = "(display-mode: standalone)";

/** False where `matchMedia` is unavailable (node tests, SSR). */
export function matchesMediaQuery(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}
