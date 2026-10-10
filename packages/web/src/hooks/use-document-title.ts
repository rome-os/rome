import { useEffect, useRef } from "react";
import { composeTitle } from "@/lib/page-title";

/**
 * Which claim a title makes. `route` is the shell's fallback for the current
 * path; `page` is the routed view naming its own subject. A page title outranks
 * a route title whenever both are mounted.
 */
export type TitleLevel = "route" | "page";

interface TitleSlot {
  owner: symbol;
  segments: readonly string[];
}

// Two slots rather than a last-write-wins assignment to document.title. The
// shell layout and the routed page both hold a title and mount in the same
// commit, and React runs a child's effect before its parent's, so a layout that
// assigned the title directly would overwrite the page's on every navigation.
// Writing to separate slots and reading them in precedence order makes the
// result independent of effect order.
const slots = new Map<TitleLevel, TitleSlot>();

function render(): void {
  if (typeof document === "undefined") return;
  const active = slots.get("page") ?? slots.get("route");
  document.title = composeTitle(active?.segments ?? []);
}

function claim(level: TitleLevel, owner: symbol, segments: readonly string[]): void {
  slots.set(level, { owner, segments });
  render();
}

// Only the current holder may release a slot. On a route change React can mount
// the next page before unmounting the previous one, and an unguarded release
// would then clear the title the new page just set.
function release(level: TitleLevel, owner: symbol): void {
  if (slots.get(level)?.owner !== owner) return;
  slots.delete(level);
  render();
}

function normalize(
  segments: string | readonly (string | null | undefined)[] | null,
): readonly string[] {
  const list = segments === null ? [] : typeof segments === "string" ? [segments] : segments;
  return list
    .filter((segment): segment is string => typeof segment === "string")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Sets `document.title` to `segments` joined most-specific-first with the site
 * name appended, for as long as the calling component is mounted. Pass null, or
 * a list that holds no name, to claim nothing — useful while the subject's name
 * is still loading, which leaves the route's own title showing rather than
 * flashing a placeholder.
 *
 * Titles are guardian-facing copy, so pass translated strings.
 */
export function useDocumentTitle(
  segments: string | readonly (string | null | undefined)[] | null,
  level: TitleLevel = "page",
): void {
  const owner = useRef<symbol | null>(null);
  owner.current ??= Symbol("document-title");

  const named = normalize(segments);
  // The list is rebuilt on every render, so the effect keys on the value rather
  // than the identity.
  const key = JSON.stringify(named);

  useEffect(() => {
    const token = owner.current as symbol;
    const current: readonly string[] = JSON.parse(key);
    if (current.length === 0) {
      release(level, token);
      return;
    }
    claim(level, token, current);
    return () => release(level, token);
  }, [key, level]);
}
