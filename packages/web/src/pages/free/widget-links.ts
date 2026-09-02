// Maps a widget placement to the full-screen route that shows the same
// surface on its own: the strip card and the full page are two views of one
// address, so "open in new tab" is a plain link, not a state handoff.

import { getFileBrowserUrlPath } from "@/lib/file-browser-routing";
import type { WidgetPlacement } from "./use-free-cells";

// Must match the `logicalRootPath` ProjectsWidget passes to FileBrowserPage —
// both name the same route namespace the full `/projects` page mounts at.
const PROJECTS_LOGICAL_ROOT = "projects";

/**
 * Build the `/full/apps/<appId>[/<route>][?<params>]` path — the app's own
 * route rides the path (per-segment encoded) and its own params ride the
 * query, mirroring how AppFullPage parses them back apart. Shared by the
 * widget iframe `src` and the header's open-in-new-tab link so the two
 * addresses cannot drift.
 */
export function buildFullAppPath(
  appId: string,
  route?: string,
  params?: Record<string, string | number | boolean>,
): string {
  const query = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) query.set(k, String(v));
  }
  const qs = query.toString();
  const routePath = route ? route.split("/").filter(Boolean).map(encodeURIComponent).join("/") : "";
  return `/full/apps/${encodeURIComponent(appId)}${routePath ? `/${routePath}` : ""}${qs ? `?${qs}` : ""}`;
}

/**
 * The full-screen href for a placement, from its persisted state. `null` when
 * the widget has no standalone page (chat is the base surface, an app tile
 * without a target is unaddressable).
 */
export function getWidgetFullHref(widget: WidgetPlacement): string | null {
  switch (widget.type) {
    case "projects":
      return getFileBrowserUrlPath(PROJECTS_LOGICAL_ROOT, widget.selectedPath ?? null);
    case "desktop":
      return "/desktop";
    case "app":
      return widget.targetId
        ? buildFullAppPath(widget.targetId, widget.route, widget.params)
        : null;
    default:
      return null;
  }
}
