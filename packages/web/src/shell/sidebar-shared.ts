// Class vocabulary shared by the pinned list (AppGrid) and the Recent zone, so
// both zones of the sidebar are one visual system.

export function isEntryActive(pathname: string, href: string): boolean {
  if (href === "/apps" || href === "/chat") {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export const LINK_CLASS =
  "rome-sidebar-link group flex h-8 w-full items-center gap-2 rounded-8 border border-transparent px-2 text-left text-ui text-foreground transition outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";

// Row state, shared by the wide rows and the rail tiles.
export const ACTIVE_CLASS = "bg-surface shadow-1 dark:bg-surface-hover";
export const IDLE_CLASS = "hover:bg-surface-hover dark:hover:bg-surface";

// The rail counterpart of LINK_CLASS: a square tile whose tooltip carries the
// label. `relative` anchors the status dots that the wide rows render inline.
export const RAIL_LINK_CLASS =
  "rome-sidebar-link relative flex size-10 items-center justify-center rounded-8 border border-transparent text-foreground transition outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";
