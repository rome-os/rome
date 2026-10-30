import {
  ActivityLogIcon,
  ArchiveIcon,
  CalendarIcon,
  DashboardIcon,
  GearIcon,
  PersonIcon,
  Pencil2Icon,
} from "@radix-ui/react-icons";
import {
  Activity,
  Archive,
  Bot,
  CalendarDays,
  Chrome as ChromeIcon,
  FolderKanban,
  Megaphone,
  User,
} from "lucide-react";
import type { ComponentType } from "react";

/** Rome's own dashboard destinations. The sidebar, the Apps launcher, page
 * titles and the Cmd+K switcher all read this list, so a new page shows up in
 * every place by being added here once. */
export interface BuiltinNavEntry {
  id: string;
  href: string;
  labelKey: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** The glyph on the Apps page tile, drawn larger than the sidebar `Icon` and
   * in the same lucide set as the first-party app icons. */
  TileGlyph?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
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
    TileGlyph: Archive,
  },
  {
    id: "people",
    href: "/people",
    labelKey: "nav.people",
    Icon: PersonIcon,
    TileGlyph: User,
  },
  // Off the sidebar until the guardian pins it: main answers assistants, so
  // their chats are read now and then rather than watched.
  { id: "assistants", href: "/assistants", labelKey: "nav.assistants", Icon: Bot, TileGlyph: Bot },
  { id: "envoys", href: "/envoys", labelKey: "nav.envoys", Icon: Megaphone, TileGlyph: Megaphone },
  {
    id: "routines",
    href: "/routines",
    labelKey: "nav.routines",
    Icon: CalendarIcon,
    TileGlyph: CalendarDays,
  },
  {
    // One page for sessions and the event log. It keeps the Sessions address,
    // which the app SDK and show_app open sessions at.
    id: "activity",
    href: "/sessions",
    labelKey: "nav.activity",
    Icon: ActivityLogIcon,
    TileGlyph: Activity,
    aliases: ["sessions", "events"],
  },
  {
    id: "desktop",
    href: "/desktop",
    labelKey: "nav.desktop",
    Icon: ChromeIcon,
    TileGlyph: ChromeIcon,
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
