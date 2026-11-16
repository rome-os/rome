import { createContext } from "react";
import { isChatPath, MAIN_CHAT_PATH } from "@/lib/chat-session";

// Class vocabulary shared by the pinned list (AppGrid) and the Recent zone, so
// both zones of the sidebar are one visual system.

// Every app lives under `/apps/<id>` with a tile of its own, so the Apps tile
// lights on the launcher alone. Chat lights on any chat, new or open.
export function isEntryActive(pathname: string, href: string): boolean {
  if (href === "/apps") {
    return pathname === href;
  }
  if (href === MAIN_CHAT_PATH) return isChatPath(pathname);
  return pathname === href || pathname.startsWith(`${href}/`);
}

export const LINK_CLASS =
  "rome-sidebar-link group flex h-10 w-full min-h-[var(--control-min-h)] items-center gap-3 rounded-12 pl-3 pr-2 text-left text-section font-normal text-foreground transition outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";

// Row state, shared by the wide rows and the rail tiles.
export const ACTIVE_CLASS =
  "bg-surface font-normal shadow-4 ring-1 ring-inset ring-border/70 dark:bg-surface-hover [&_.rome-sidebar-icon]:text-primary";
export const IDLE_CLASS = "hover:bg-surface-hover dark:hover:bg-surface";

// The rail counterpart of LINK_CLASS: a square tile whose tooltip carries the
// label. `relative` anchors the status dots that the wide rows render inline.
export const RAIL_LINK_CLASS =
  "rome-sidebar-link relative flex size-10 items-center justify-center rounded-12 text-foreground transition outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";

// The 12px left padding keeps each icon centered when the rail shows names.
export const RAIL_ROW_CLASS =
  "rome-sidebar-link relative flex h-10 w-full min-w-0 items-center gap-3 rounded-12 pl-3 pr-2 text-left text-section font-normal text-foreground transition outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50";

/** Whether the rail shows names beside its icons. The shell decides; every
 *  tile reads it, so the nav and the Recent zone switch together. */
export const RailLabelsContext = createContext(false);

export function railLinkClass(labelled: boolean): string {
  return labelled ? RAIL_ROW_CLASS : RAIL_LINK_CLASS;
}
