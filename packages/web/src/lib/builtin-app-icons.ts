import { FileClock, Inbox, LayoutGrid, Zap, type LucideIcon } from "lucide-react";

// These first-party apps share Rome's page icon treatment. Keep every other
// app's self-painted icon, including Welcome to Rome.
const BUILTIN_APP_ICONS: ReadonlyMap<string, LucideIcon> = new Map([
  ["briefing", FileClock],
  ["inbox", Inbox],
  ["showcases", LayoutGrid],
  ["skills", Zap],
]);

export function getBuiltinAppIcon(appId: string): LucideIcon | undefined {
  return BUILTIN_APP_ICONS.get(appId);
}
