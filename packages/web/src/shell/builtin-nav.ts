import {
  ActivityLogIcon,
  ArchiveIcon,
  CalendarIcon,
  DashboardIcon,
  GearIcon,
  PersonIcon,
  Pencil2Icon,
} from "@radix-ui/react-icons";
import { Chrome as ChromeIcon, FolderKanban, MessagesSquare, Store } from "lucide-react";
import type { ComponentType } from "react";

/** Rome's own dashboard destinations. The sidebar, the Apps launcher, page
 * titles and the Cmd+K switcher all read this list, so a new page shows up in
 * every place by being added here once. */
export interface BuiltinNavEntry {
  id: string;
  href: string;
  labelKey: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
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
  { id: "sessions", href: "/sessions", labelKey: "nav.sessions", Icon: MessagesSquare },
  { id: "memory", href: "/memory", labelKey: "nav.memory", Icon: ArchiveIcon },
  { id: "people", href: "/people", labelKey: "nav.people", Icon: PersonIcon },
  { id: "routines", href: "/routines", labelKey: "nav.routines", Icon: CalendarIcon },
  { id: "activity", href: "/activity", labelKey: "nav.activity", Icon: ActivityLogIcon },
  { id: "store", href: "/apps/store", labelKey: "nav.store", Icon: Store },
  {
    id: "desktop",
    href: "/desktop",
    labelKey: "nav.desktop",
    Icon: ChromeIcon,
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
