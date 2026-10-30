import {
  ActivityLogIcon,
  ArchiveIcon,
  CalendarIcon,
  DashboardIcon,
  GearIcon,
  PersonIcon,
  Pencil2Icon,
} from "@radix-ui/react-icons";
import { Bot, Chrome as ChromeIcon, FolderKanban, Megaphone } from "lucide-react";
import type { ComponentType } from "react";
import activityTile from "@/assets/builtin-tiles/activity.svg";
import assistantsTile from "@/assets/builtin-tiles/assistants.svg";
import desktopTile from "@/assets/builtin-tiles/desktop.svg";
import envoysTile from "@/assets/builtin-tiles/envoys.svg";
import memoryTile from "@/assets/builtin-tiles/memory.svg";
import peopleTile from "@/assets/builtin-tiles/people.svg";
import routinesTile from "@/assets/builtin-tiles/routines.svg";

/** Rome's own dashboard destinations. The sidebar, the Apps launcher, page
 * titles and the Cmd+K switcher all read this list, so a new page shows up in
 * every place by being added here once. */
export interface BuiltinNavEntry {
  id: string;
  href: string;
  labelKey: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** The colored tile the Apps page shows, drawn to the app icon rule so it
   * sits with the first-party apps. The sidebar keeps the line `Icon`. */
  tileIconUrl?: string;
  sidebarIconMotion?: "apps" | "chat";
  /** Extra search terms, matched alongside the translated label and the id. */
  aliases?: readonly string[];
}

export const APP_NAV: readonly BuiltinNavEntry[] = [
  {
    id: "apps",
    href: "/apps",
    labelKey: "nav.apps",
    Icon: DashboardIcon,
    sidebarIconMotion: "apps",
  },
  { id: "projects", href: "/projects", labelKey: "nav.projects", Icon: FolderKanban },
  {
    id: "memory",
    href: "/memory",
    labelKey: "nav.memory",
    Icon: ArchiveIcon,
    tileIconUrl: memoryTile,
  },
  {
    id: "people",
    href: "/people",
    labelKey: "nav.people",
    Icon: PersonIcon,
    tileIconUrl: peopleTile,
  },
  // Off the sidebar until the guardian pins it: main answers assistants, so
  // their chats are read now and then rather than watched.
  {
    id: "assistants",
    href: "/assistants",
    labelKey: "nav.assistants",
    Icon: Bot,
    tileIconUrl: assistantsTile,
  },
  {
    id: "envoys",
    href: "/envoys",
    labelKey: "nav.envoys",
    Icon: Megaphone,
    tileIconUrl: envoysTile,
  },
  {
    id: "routines",
    href: "/routines",
    labelKey: "nav.routines",
    Icon: CalendarIcon,
    tileIconUrl: routinesTile,
  },
  {
    // One page for sessions and the event log. It keeps the Sessions address,
    // which the app SDK and show_app open sessions at.
    id: "activity",
    href: "/sessions",
    labelKey: "nav.activity",
    Icon: ActivityLogIcon,
    tileIconUrl: activityTile,
    aliases: ["sessions", "events"],
  },
  {
    id: "desktop",
    href: "/desktop",
    labelKey: "nav.desktop",
    Icon: ChromeIcon,
    tileIconUrl: desktopTile,
    // The label is translated, so a non-English UI still finds it in English.
    aliases: ["browser"],
  },
  {
    id: "chat",
    href: "/chat",
    labelKey: "nav.chat",
    Icon: Pencil2Icon,
    sidebarIconMotion: "chat",
  },
  { id: "settings", href: "/settings", labelKey: "nav.settings", Icon: GearIcon },
] as const;
